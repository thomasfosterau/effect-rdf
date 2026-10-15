#!/usr/bin/env sh
# Fetches the W3C and community conformance test suites used by the
# packages' conformance tests into ./.test-suites (git-ignored).
# Conformance tests are skipped when the suites are not present.
set -eu
DIR="${RDF_TEST_SUITES:-$(cd "$(dirname "$0")/.." && pwd)/.test-suites}"
mkdir -p "$DIR"
fetch() {
  name="$1"
  repo="$2"
  if [ -d "$DIR/$name/.git" ]; then
    git -C "$DIR/$name" pull -q --depth 1 || true
  else
    git clone -q --depth 1 "https://github.com/$repo" "$DIR/$name"
  fi
}
fetch rdf-tests w3c/rdf-tests
fetch json-ld-api w3c/json-ld-api
fetch json-ld-framing w3c/json-ld-framing
fetch data-shapes w3c/data-shapes
fetch shexTest shexSpec/shexTest
fetch N3 w3c/N3
echo "Test suites available in $DIR"
