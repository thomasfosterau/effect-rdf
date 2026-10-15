/**
 * The SHACL vocabulary (`sh:`, `http://www.w3.org/ns/shacl#`).
 *
 * ```ts
 * import { Vocabulary } from "@thomasfosterau/effect-shacl"
 *
 * Vocabulary.sh.NodeShape // NamedNode<"http://www.w3.org/ns/shacl#NodeShape">
 * ```
 *
 * @since 0.1.0
 */
import { Namespace } from '@thomasfosterau/effect-rdf';

/**
 * The SHACL namespace IRI.
 *
 * @since 0.1.0
 * @category constants
 */
export const SH = 'http://www.w3.org/ns/shacl#';

/**
 * The SHACL vocabulary: classes, properties and individuals of SHACL Core and
 * SHACL-SPARQL.
 *
 * @since 0.1.0
 * @category vocabularies
 */
export const sh = Namespace.vocabulary(SH, [
  // Shapes and targets
  'Shape',
  'NodeShape',
  'PropertyShape',
  'targetNode',
  'targetClass',
  'targetSubjectsOf',
  'targetObjectsOf',
  'target',
  'Target',
  'TargetType',
  'SPARQLTarget',
  'SPARQLTargetType',
  'severity',
  'message',
  'deactivated',
  'path',
  'name',
  'description',
  'order',
  'group',
  'defaultValue',
  'shapesGraph',
  'suggestedShapesGraph',
  'entailment',
  'declare',
  'prefix',
  'namespace',
  'prefixes',
  'PrefixDeclaration',
  // Paths
  'alternativePath',
  'inversePath',
  'zeroOrMorePath',
  'oneOrMorePath',
  'zeroOrOnePath',
  // Severities
  'Severity',
  'Info',
  'Warning',
  'Violation',
  // Validation reports
  'ValidationReport',
  'ValidationResult',
  'AbstractResult',
  'conforms',
  'result',
  'focusNode',
  'resultPath',
  'value',
  'sourceShape',
  'sourceConstraint',
  'sourceConstraintComponent',
  'resultSeverity',
  'resultMessage',
  'detail',
  // Node kinds
  'NodeKind',
  'BlankNode',
  'IRI',
  'Literal',
  'BlankNodeOrIRI',
  'BlankNodeOrLiteral',
  'IRIOrLiteral',
  // Constraint parameters
  'class',
  'datatype',
  'nodeKind',
  'minCount',
  'maxCount',
  'minExclusive',
  'minInclusive',
  'maxExclusive',
  'maxInclusive',
  'minLength',
  'maxLength',
  'pattern',
  'flags',
  'languageIn',
  'uniqueLang',
  'equals',
  'disjoint',
  'lessThan',
  'lessThanOrEquals',
  'not',
  'and',
  'or',
  'xone',
  'node',
  'property',
  'qualifiedValueShape',
  'qualifiedValueShapesDisjoint',
  'qualifiedMinCount',
  'qualifiedMaxCount',
  'closed',
  'ignoredProperties',
  'hasValue',
  'in',
  // Constraint components
  'ConstraintComponent',
  'Parameter',
  'Parameterizable',
  'parameter',
  'optional',
  'validator',
  'nodeValidator',
  'propertyValidator',
  'Validator',
  'SPARQLAskValidator',
  'SPARQLSelectValidator',
  'labelTemplate',
  'ClassConstraintComponent',
  'DatatypeConstraintComponent',
  'NodeKindConstraintComponent',
  'MinCountConstraintComponent',
  'MaxCountConstraintComponent',
  'MinExclusiveConstraintComponent',
  'MinInclusiveConstraintComponent',
  'MaxExclusiveConstraintComponent',
  'MaxInclusiveConstraintComponent',
  'MinLengthConstraintComponent',
  'MaxLengthConstraintComponent',
  'PatternConstraintComponent',
  'LanguageInConstraintComponent',
  'UniqueLangConstraintComponent',
  'EqualsConstraintComponent',
  'DisjointConstraintComponent',
  'LessThanConstraintComponent',
  'LessThanOrEqualsConstraintComponent',
  'NotConstraintComponent',
  'AndConstraintComponent',
  'OrConstraintComponent',
  'XoneConstraintComponent',
  'NodeConstraintComponent',
  'PropertyConstraintComponent',
  'QualifiedMinCountConstraintComponent',
  'QualifiedMaxCountConstraintComponent',
  'ClosedConstraintComponent',
  'HasValueConstraintComponent',
  'InConstraintComponent',
  // SHACL-SPARQL
  'sparql',
  'select',
  'ask',
  'SPARQLConstraint',
  'SPARQLConstraintComponent',
  'SPARQLExecutable',
  'SPARQLSelectExecutable',
  'SPARQLAskExecutable',
  'this',
]);
