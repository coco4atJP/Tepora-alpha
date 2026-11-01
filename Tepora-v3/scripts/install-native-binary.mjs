import {copyFile,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';

/**
 * Never rewrite an inode that may already have executable pages/code-signature state.
 *
 * Windows cannot replace a file that another handle still has open: libuv's
 * fs__rename() calls MoveFileExW(MOVEFILE_REPLACE_EXISTING), which fails with
 * ERROR_ACCESS_DENIED (surfaced by Node as EPERM) while the destination is
 * mapped or open. A running Tepora instance keeps the loaded addon or the
 * bundled Node runtime open, so the atomic swap must fall back to a
 * rename-away-then-publish sequence there. POSIX keeps the single atomic
 * rename because it can replace an open destination inode directly.
 */

/** Windows-only codes that mean "the destination is in use", not "denied". */
export const DESTINATION_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function isDestinationBusy(error) {
  return Boolean(error) && DESTINATION_BUSY_CODES.has(error.code);
}

/**
 * Publish a new file over an existing destination that refuses replacement.
 *
 * The old file is first renamed aside (allowed while it is open), then the new
 * bytes are renamed into place, and only afterwards is the old file removed.
 * A failure before the publish step leaves the original destination intact.
 */
async function publishOverBusyDestination(temporary, destination, {renameFile, remove}) {
  const retired = destination + '.' + randomUUID() + '.retired';
  let moved = false;
  try {
    await renameFile(destination, retired);
    moved = true;
    await renameFile(temporary, destination);
  } catch (error) {
    // The new bytes never reached the destination: put the original back so
    // a failed publish never removes a working binary.
    if (moved) {
      try { await renameFile(retired, destination); } catch { /* keep the retired copy for recovery */ }
    }
    throw error;
  }
  // The new bytes are published, so a retired file that is still mapped or
  // held open must not fail the install. It stays as a harmless leftover.
  try {
    await remove(retired, {force: true});
  } catch (error) {
    if (!isDestinationBusy(error)) throw error;
  }
}

// Injectable effects let the Windows busy-destination path be exercised on
// every platform without opening a real handle against a real binary.
export async function installNativeBinary(source, destination, {
  copy = copyFile,
  renameFile = rename,
  remove = rm,
} = {}) {
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await copy(source, temporary, constants.COPYFILE_EXCL);
    try {
      await renameFile(temporary, destination);
    } catch (error) {
      if (!isDestinationBusy(error)) throw error;
      await publishOverBusyDestination(temporary, destination, {renameFile, remove});
    }
  } finally {
    await remove(temporary, {force: true});
  }
}
