# Model catalog source fixtures

`fixtures.json` contains 18 JSON input/output cases generated directly from
`Tepora-v3/core/model-catalog.mjs::parseCatalog`, without importing a provider
package, making a request, or executing an advertised model endpoint.

Source SHA256: `0e8d47f536cdf4c4f81638791dff92af9376e015e7fb444a90068eea9cee604a`.

Cases preserve integer-key iteration order, UTF-16 truncation and isolated
surrogates, array/object quirks, price-number validation, modality allowlists,
unknown executable-field removal and source errors. A separate Rust test covers
the 30,000-model limit without storing a large repeated fixture. `verified:false`
remains metadata provenance; it is never promoted into a capability or quality
claim.
