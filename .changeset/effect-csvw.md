---
'@thomasfosterau/effect-csvw': minor
---

New package `@thomasfosterau/effect-csvw`: CSV on the Web over already-parsed tables. `Metadata` decodes and normalizes CSVW metadata documents into `Schema`-described table groups (with warnings for invalid properties and `MetadataError` for specification errors); `Table` reads a parsed table with its dialect, checks its embedded metadata for compatibility and annotates every cell (datatypes, number, date and boolean formats, `null`, `default`, `required`, `separator`, virtual columns, URI templates); `Processor` runs it all from a metadata or tabular data file through a `Loader` service, validating primary and foreign keys, into a positioned `Report`; `Csv2Rdf` and `Csv2Json` convert the result in standard or minimal mode. Locating metadata through HTTP `Link` headers and `/.well-known/csvm` is not yet supported.
