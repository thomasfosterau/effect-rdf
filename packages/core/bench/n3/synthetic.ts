/**
 * The synthetic N3 document the N3 benchmarks parse: 3,000 blocks that
 * between them use prefixes, literals of every kind, blank-node property
 * lists, collections, formulas, paths, `is … of`, rules and `=`.
 */
const block = (i: number) => `
# block ${i}
@prefix ex: <http://example.org/> .
ex:s${i} a ex:Thing ; ex:name "thing ${i}"@en , "chose"@fr ; ex:n ${i} , ${i}.5 , ${i}e3 ;
  ex:knows [ ex:p ex:o ; ex:q ( 1 2 "three" <http://example.org/four> ) ] ;
  ex:says { ex:a ex:b ex:c . ?x ex:d _:b${i} } ;
  ex:path ex:s${i}!ex:p^ex:q ; is ex:inverse of ex:t${i} ; <= { ?y ex:e ?z } .
{ ?x a ex:Thing . ?x ex:n ?n } => { ?x ex:value ?n ; ex:flag true } .
ex:t${i} = ex:u${i} ; ex:label """long
string ${i}""" ; ex:dt "2024-01-0${i % 9}"^^<http://www.w3.org/2001/XMLSchema#date> .
`;
/** The document (about 1.6 MB). */
export const big = Array.from({ length: 3000 }, (_, i) => block(i)).join('');
