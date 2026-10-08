# Runtime-generated TLS test identities

The network tests use the Rust dev-dependency `rcgen` to generate a fresh
self-signed localhost certificate and private key at test runtime. No certificate
or private-key material is stored in the repository. Private keys remain only in
memory; tests never print them or write them to files.

A temporary file containing only the generated public certificate exercises the
production NODE_EXTRA_CA_CERTS PEM loader and is removed after the test. The
fixtures require no external OpenSSL, Python, or Node executable.

Coverage retains custom-CA success for the original localhost hostname,
wrong-hostname rejection, rejection without the custom trust root, and bounded /
malformed optional PEM diagnostics. Production still uses ordinary certificate
and hostname verification, with no insecure mode.
