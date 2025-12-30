/**
 * SessionHistory Component
 * 
 * Displays a list of chat sessions with options to:
 * - Create new session
 * - Switch between sessions
 * - Delete sessions
 * - Rename sessions
 */

import React, { useState } from 'react';
import { Session } from '../../hooks/useSessions';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../ui/ConfirmDialog';

interface SessionHistoryProps {
  sessions: Session[];
  currentSessionId: string;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  loading?: boolean;
}

export const SessionHistory: React.FC<SessionHistoryProps> = ({
  sessions,
  currentSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onRenameSession,
  loading = false,
}) => {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  // UX改善3: 削除確認ダイアログ用state
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const handleStartEdit = (session: Session) => {
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const handleSaveEdit = () => {
    if (editingId && editTitle.trim()) {
      onRenameSession(editingId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return t('today', 'Today');
    if (days === 1) return t('yesterday', 'Yesterday');
    if (days < 7) return t('daysAgo', '{{count}} days ago', { count: days });
    return date.toLocaleDateString();
  };

  return (
    <div className="session-history">
      {/* Header */}
      <div className="session-history-header">
        <h3>{t('sessionHistory', 'Sessions')}</h3>
        <button
          className="btn-new-session"
          onClick={onCreateSession}
          disabled={loading}
          aria-label={t('newSession', 'New Session')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Session List */}
      <div className="session-list" role="list" aria-label={t('sessionList', 'Session List')}>
        {loading && sessions.length === 0 ? (
          <div className="session-loading">{t('loading', 'Loading...')}</div>
        ) : sessions.length === 0 ? (
          <div className="session-empty">{t('noSessions', 'No sessions yet')}</div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === currentSessionId ? 'active' : ''}`}
              role="listitem"
            >
              {editingId === session.id ? (
                <div className="session-edit">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveEdit();
                      if (e.key === 'Escape') handleCancelEdit();
                    }}
                    autoFocus
                    aria-label={t('editSessionTitle', 'Edit session title')}
                  />
                  <button onClick={handleSaveEdit} className="btn-save" aria-label={t('save', 'Save')}>
                    ✓
                  </button>
                  <button onClick={handleCancelEdit} className="btn-cancel" aria-label={t('cancel', 'Cancel')}>
                    ✕
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="session-content"
                    onClick={() => onSelectSession(session.id)}
                    aria-current={session.id === currentSessionId ? 'true' : 'false'}
                  >
                    <div className="session-title">{session.title}</div>
                    <div className="session-meta">
                      <span className="session-date">{formatDate(session.updated_at)}</span>
                      {session.message_count !== undefined && (
                        <span className="session-count">
                          {session.message_count} {t('messages', 'msgs')}
                        </span>
                      )}
                    </div>
                    {session.preview && (
                      <div className="session-preview">{session.preview}</div>
                    )}
                  </button>
                  <div className="session-actions">
                    <button
                      className="btn-edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStartEdit(session);
                      }}
                      aria-label={t('rename', 'Rename')}
                    >
                      ✎
                    </button>
                    {session.id !== 'default' && (
                      <button
                        className="btn-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTargetId(session.id);
                        }}
                        aria-label={t('delete', 'Delete')}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <style>{`
        .session-history {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--color-bg-secondary, rgba(0, 0, 0, 0.2));
          border-radius: 8px;
          overflow: hidden;
        }

        .session-history-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
        }

        .session-history-header h3 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: var(--color-text-primary, #fff);
        }

        .btn-new-session {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: none;
          border-radius: 6px;
          background: var(--color-primary, #6366f1);
          color: white;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-new-session:hover:not(:disabled) {
          background: var(--color-primary-hover, #818cf8);
          transform: scale(1.05);
        }

        .btn-new-session:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .session-list {
          flex: 1;
          overflow-y: auto;
          padding: 8px;
        }

        .session-item {
          display: flex;
          align-items: stretch;
          margin-bottom: 4px;
          border-radius: 8px;
          background: transparent;
          transition: background 0.2s;
        }

        .session-item:hover {
          background: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
        }

        .session-item.active {
          background: var(--color-bg-active, rgba(99, 102, 241, 0.2));
          border-left: 3px solid var(--color-primary, #6366f1);
        }

        .session-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          padding: 10px 12px;
          border: none;
          background: transparent;
          color: inherit;
          cursor: pointer;
          text-align: left;
          min-width: 0;
        }

        .session-title {
          font-size: 13px;
          font-weight: 500;
          color: var(--color-text-primary, #fff);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          width: 100%;
        }

        .session-meta {
          display: flex;
          gap: 8px;
          font-size: 11px;
          color: var(--color-text-secondary, rgba(255, 255, 255, 0.6));
          margin-top: 2px;
        }

        .session-preview {
          font-size: 11px;
          color: var(--color-text-muted, rgba(255, 255, 255, 0.4));
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          width: 100%;
          margin-top: 4px;
        }

        .session-actions {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 4px;
          opacity: 0;
          transition: opacity 0.2s;
        }

        .session-item:hover .session-actions {
          opacity: 1;
        }

        .session-actions button {
          width: 24px;
          height: 24px;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--color-text-secondary, rgba(255, 255, 255, 0.6));
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }

        .session-actions button:hover {
          background: var(--color-bg-hover, rgba(255, 255, 255, 0.1));
          color: var(--color-text-primary, #fff);
        }

        .btn-delete:hover {
          background: rgba(239, 68, 68, 0.2) !important;
          color: #f87171 !important;
        }

        .session-edit {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 8px;
          width: 100%;
        }

        .session-edit input {
          flex: 1;
          padding: 6px 8px;
          border: 1px solid var(--color-primary, #6366f1);
          border-radius: 4px;
          background: var(--color-bg-input, rgba(0, 0, 0, 0.3));
          color: var(--color-text-primary, #fff);
          font-size: 13px;
          outline: none;
        }

        .session-edit .btn-save,
        .session-edit .btn-cancel {
          width: 24px;
          height: 24px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }

        .session-edit .btn-save {
          background: var(--color-primary, #6366f1);
          color: white;
        }

        .session-edit .btn-cancel {
          background: transparent;
          color: var(--color-text-secondary, rgba(255, 255, 255, 0.6));
        }

        .session-loading,
        .session-empty {
          padding: 24px;
          text-align: center;
          color: var(--color-text-muted, rgba(255, 255, 255, 0.4));
          font-size: 13px;
        }
      `}</style>

      {/* UX改善3: カスタム削除確認ダイアログ */}
      <ConfirmDialog
        isOpen={deleteTargetId !== null}
        title={t('deleteSession', 'セッションを削除')}
        message={t('confirmDeleteMessage', 'このセッションを削除してもよろしいですか？会話履歴もすべて削除されます。')}
        confirmLabel={t('delete', '削除')}
        cancelLabel={t('cancel', 'キャンセル')}
        variant="danger"
        onConfirm={() => {
          if (deleteTargetId) {
            onDeleteSession(deleteTargetId);
          }
          setDeleteTargetId(null);
        }}
        onCancel={() => setDeleteTargetId(null)}
      />
    </div>
  );
};

export default SessionHistory;
