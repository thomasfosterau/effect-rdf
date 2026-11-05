---
'@thomasfosterau/effect-shacl': minor
'@thomasfosterau/effect-shex': minor
---

Validation schemas report structured issues. `effect-shex` gains `Validator.schema(validator, shapeMap | { node, shape })`, a `Dataset` → `Dataset` filter like SHACL's, and `Validator.formatResult`. Both packages' `Validator.schema` now fail with a `SchemaIssue.Composite` holding one `InvalidValue` per failing result, whose `message` annotation is the formatted result and whose `result` annotation is the result itself. SHACL's `Validator.schema` takes a `failOn` severity option and by default fails only on `sh:Violation` results (it used to fail on any result, warnings included); `ValidationReport.formatResult` formats one result.
