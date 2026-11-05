import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Equal from 'effect/Equal';
import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';
import {
  Dataset,
  Isomorphism,
  Namespace,
  Resource,
  Term,
  TermCodec,
  Vocab,
  Xsd,
} from '../src/index.ts';

const ex = Namespace.make('http://example.org/');
const { rdf } = Vocab;
const q = (s: Term.Subject, p: Term.NamedNode, o: Term.Object, g?: Term.Graph) =>
  g === undefined ? Term.quad(s, p, o) : Term.quad(s, p, o, g);

const Address = Schema.Struct({
  city: Resource.property(ex('city'), TermCodec.string),
}).pipe(Resource.describe({ type: ex('Address') }));

const Person = Schema.Struct({
  id: TermCodec.namedNode,
  name: Resource.property(ex('name'), TermCodec.string),
  age: Schema.optional(Resource.property(ex('age'), TermCodec.integer)),
  nicks: Resource.property(ex('nick'), Schema.Array(TermCodec.string)),
  address: Schema.optional(Resource.property(ex('address'), Address)),
}).pipe(Resource.describe({ type: ex('Person'), id: 'id' }));

const alice = ex('alice');
const bob = ex('bob');

const errorMessage = <A>(effect: Effect.Effect<A, Schema.SchemaError>): Effect.Effect<string> =>
  Effect.match(effect, { onFailure: (e) => e.message, onSuccess: () => 'succeeded' });

describe('Resource', () => {
  it.effect('decodes multi-valued, optional and nested blank-node fields', () =>
    Effect.gen(function* () {
      const home = Term.blankNode('home');
      const data = Dataset.make(
        q(alice, rdf.type, ex('Person')),
        q(alice, ex('name'), Term.literal('Alice')),
        q(alice, ex('nick'), Term.literal('Zed')),
        q(alice, ex('nick'), Term.literal('Al')),
        q(alice, ex('address'), home),
        q(home, rdf.type, ex('Address')),
        q(home, ex('city'), Term.literal('Paris')),
      );
      const value = yield* Resource.decode(Person)(data, alice);
      expect(value).toStrictEqual({
        id: alice,
        name: 'Alice',
        nicks: ['Al', 'Zed'],
        address: { city: 'Paris' },
      });

      // Round trip: the nested address without an id becomes a fresh blank node.
      const quads = yield* Resource.encode(Person)(alice, value);
      expect(Isomorphism.isomorphic(Dataset.fromIterable(quads), data)).toBe(true);
    }),
  );

  it.effect('round-trips an optional value that is present', () =>
    Effect.gen(function* () {
      const value = { id: bob, name: 'Bob', age: 42, nicks: [] };
      const quads = yield* Resource.encode(Person)(bob, value);
      const data = Dataset.fromIterable(quads);
      expect(Dataset.has(data, q(bob, ex('age'), Xsd.integer(42)))).toBe(true);
      expect(yield* Resource.decode(Person)(data, bob)).toStrictEqual(value);
    }),
  );

  it.effect('reads the annotation on either side of Schema.optional and Schema.Array', () =>
    Effect.gen(function* () {
      const Either = Schema.Struct({
        age: Resource.property(ex('age'), Schema.optional(TermCodec.integer)),
        nicks: Schema.Array(Resource.property(ex('nick'), TermCodec.string)),
        tags: Schema.optionalKey(Resource.property(ex('tag'), Schema.Array(TermCodec.string))),
      });
      const data = Dataset.make(q(alice, ex('nick'), Term.literal('Al')));
      expect(yield* Resource.decode(Either)(data, alice)).toStrictEqual({ nicks: ['Al'] });
      const value = { age: 3, nicks: ['b', 'a'], tags: ['t'] };
      const quads = yield* Resource.encode(Either)(alice, value);
      expect(quads).toHaveLength(4);
      expect(yield* Resource.decode(Either)(Dataset.fromIterable(quads), alice)).toStrictEqual({
        age: 3,
        nicks: ['a', 'b'],
        tags: ['t'],
      });
    }),
  );

  it.effect('reports cardinality failures at the field path', () =>
    Effect.gen(function* () {
      const base = [q(alice, rdf.type, ex('Person'))];
      const none = Dataset.make(...base);
      expect(yield* errorMessage(Resource.decode(Person)(none, alice))).toBe(
        'Missing value for <http://example.org/name>\n  at ["name"]',
      );
      const two = Dataset.make(
        ...base,
        q(alice, ex('name'), Term.literal('A')),
        q(alice, ex('name'), Term.literal('B')),
      );
      expect(yield* errorMessage(Resource.decode(Person)(two, alice))).toBe(
        'Expected exactly one value for <http://example.org/name>, got 2\n  at ["name"]',
      );
      const ages = Dataset.make(
        ...base,
        q(alice, ex('name'), Term.literal('A')),
        q(alice, ex('age'), Xsd.integer(1)),
        q(alice, ex('age'), Xsd.integer(2)),
      );
      expect(yield* errorMessage(Resource.decode(Person)(ages, alice))).toBe(
        'Expected at most one value for <http://example.org/age>, got 2\n  at ["age"]',
      );
      const badValue = Dataset.make(...base, q(alice, ex('name'), Xsd.integer(1)));
      expect(yield* errorMessage(Resource.decode(Person)(badValue, alice))).toContain(
        'Expected a string literal',
      );
      expect(yield* errorMessage(Resource.decode(Person)(badValue, alice))).toContain(
        'at ["name"]',
      );
    }),
  );

  it.effect('requires the described rdf:type, also on nested resources', () =>
    Effect.gen(function* () {
      const home = Term.blankNode();
      const untyped = Dataset.make(q(alice, ex('name'), Term.literal('A')));
      expect(yield* errorMessage(Resource.decode(Person)(untyped, alice))).toBe(
        'Expected <http://example.org/alice> to have rdf:type <http://example.org/Person>',
      );
      const nested = Dataset.make(
        q(alice, rdf.type, ex('Person')),
        q(alice, ex('name'), Term.literal('A')),
        q(alice, ex('address'), home),
        q(home, ex('city'), Term.literal('Paris')),
      );
      expect(yield* errorMessage(Resource.decode(Person)(nested, alice))).toContain(
        'at ["address"]',
      );
    }),
  );

  it.effect('reads and writes RDF lists', () =>
    Effect.gen(function* () {
      const Playlist = Schema.Struct({
        tracks: Resource.property(ex('tracks'), Resource.list(TermCodec.string)),
        tags: Schema.optional(Resource.property(ex('tags'), Resource.list(TermCodec.string))),
      });
      const value = { tracks: ['b', 'a', 'c'] };
      const quads = yield* Resource.encode(Playlist)(alice, value);
      const data = Dataset.fromIterable(quads);
      expect(
        Dataset.list(data, Dataset.objectsOf(data, alice, ex('tracks'))[0] ?? rdf.nil),
      ).toEqual(expect.objectContaining({ _tag: 'Some' }));
      expect(yield* Resource.decode(Playlist)(data, alice)).toStrictEqual(value);

      const empty = yield* Resource.encode(Playlist)(alice, { tracks: [] });
      expect(empty).toStrictEqual([Term.quad(alice, ex('tracks'), rdf.nil)]);
      expect(yield* Resource.decode(Playlist)(Dataset.fromIterable(empty), alice)).toStrictEqual({
        tracks: [],
      });

      const broken = Dataset.make(q(alice, ex('tracks'), Term.blankNode('l')));
      expect(yield* errorMessage(Resource.decode(Playlist)(broken, alice))).toBe(
        'Expected an RDF list for <http://example.org/tracks>, got _:l\n  at ["tracks"]',
      );
    }),
  );

  it.effect('picks language-tagged values in order of preference', () =>
    Effect.gen(function* () {
      const Label = Schema.Struct({
        label: Resource.property(ex('label'), TermCodec.localized, { languages: ['fr', 'en', ''] }),
        all: Resource.property(ex('label'), Schema.Array(TermCodec.string), {
          languages: ['EN', ''],
        }),
      });
      const data = Dataset.make(
        q(alice, ex('label'), Term.literal('Alice', 'en')),
        q(alice, ex('label'), Term.literal('Alix', 'fr')),
        q(alice, ex('label'), Term.literal('Alicia', 'es')),
        q(alice, ex('label'), Term.literal('alice')),
      );
      expect(yield* Resource.decode(Label)(data, alice)).toStrictEqual({
        label: { value: 'Alix', language: 'fr' },
        all: ['Alice', 'alice'],
      });
      const untagged = Dataset.make(
        q(alice, ex('label'), Term.literal('Alicia', 'es')),
        q(alice, ex('label'), Term.literal('alice')),
      );
      expect((yield* Resource.decode(Label)(untagged, alice)).label).toStrictEqual({
        value: 'alice',
      });

      // The decode option is the default for fields without their own list.
      const Name = Schema.Struct({ name: Resource.property(ex('label'), TermCodec.string) });
      expect(yield* Resource.decode(Name)(data, alice, { languages: ['es'] })).toStrictEqual({
        name: 'Alicia',
      });
    }),
  );

  it.effect('reads and writes inverse properties', () =>
    Effect.gen(function* () {
      const Team = Schema.Struct({
        members: Resource.property(ex('memberOf'), Schema.Array(TermCodec.namedNode), {
          inverse: true,
        }),
      });
      const team = ex('team');
      const data = Dataset.make(q(bob, ex('memberOf'), team), q(alice, ex('memberOf'), team));
      const value = yield* Resource.decode(Team)(data, team);
      expect(value).toStrictEqual({ members: [alice, bob] });
      const quads = yield* Resource.encode(Team)(team, value);
      expect(Equal.equals(Dataset.fromIterable(quads), data)).toBe(true);

      const Bad = Schema.Struct({
        of: Resource.property(ex('p'), TermCodec.string, { inverse: true }),
      });
      expect(yield* errorMessage(Resource.encode(Bad)(team, { of: 'x' }))).toBe(
        'Expected an IRI or blank node for ^<http://example.org/p>, got "x"\n  at ["of"]',
      );
    }),
  );

  it.effect('scopes decoding and encoding to a graph', () =>
    Effect.gen(function* () {
      const Name = Schema.Struct({ name: Resource.property(ex('name'), TermCodec.string) });
      const g1 = ex('g1');
      const g2 = ex('g2');
      const data = Dataset.make(
        q(alice, ex('name'), Term.literal('One'), g1),
        q(alice, ex('name'), Term.literal('Two'), g2),
      );
      expect(yield* errorMessage(Resource.decode(Name)(data, alice))).toContain('got 2');
      expect(yield* Resource.decode(Name)(data, alice, { graph: g2 })).toStrictEqual({
        name: 'Two',
      });
      const quads = yield* Resource.encode(Name)(alice, { name: 'Two' }, { graph: g2 });
      expect(quads).toStrictEqual([q(alice, ex('name'), Term.literal('Two'), g2)]);
    }),
  );

  it.effect('fails on a cycle through a recursive schema', () =>
    Effect.gen(function* () {
      interface Node {
        readonly name: string;
        readonly next: ReadonlyArray<Node>;
      }
      const NodeSchema: Schema.Codec<Node, unknown> = Schema.Struct({
        name: Resource.property(ex('name'), TermCodec.string),
        next: Resource.property(
          ex('next'),
          Schema.Array(Schema.suspend((): Schema.Codec<Node, unknown> => NodeSchema)),
        ),
      });
      const chain = Dataset.make(
        q(alice, ex('name'), Term.literal('a')),
        q(alice, ex('next'), bob),
        q(bob, ex('name'), Term.literal('b')),
      );
      expect(yield* Resource.decode(NodeSchema)(chain, alice)).toStrictEqual({
        name: 'a',
        next: [{ name: 'b', next: [] }],
      });
      const cyclic = Dataset.add(chain, q(bob, ex('next'), alice));
      expect(yield* errorMessage(Resource.decode(NodeSchema)(cyclic, alice))).toBe(
        'Cycle: <http://example.org/alice> is already being decoded as this resource\n  at ["next"][0]["next"][0]',
      );
    }),
  );

  it.effect('decodes every resource of the described type', () =>
    Effect.gen(function* () {
      const data = Dataset.make(
        q(bob, rdf.type, ex('Person')),
        q(bob, ex('name'), Term.literal('Bob')),
        q(alice, rdf.type, ex('Person')),
        q(alice, ex('name'), Term.literal('Alice')),
        q(ex('carol'), ex('name'), Term.literal('Carol')),
      );
      const all = yield* Resource.decodeAll(Person)(data);
      expect(all).toStrictEqual([
        { subject: alice, value: { id: alice, name: 'Alice', nicks: [] } },
        { subject: bob, value: { id: bob, name: 'Bob', nicks: [] } },
      ]);
      const Untyped = Schema.Struct({ name: Resource.property(ex('name'), TermCodec.string) });
      expect(yield* errorMessage(Resource.decodeAll(Untyped)(data))).toBe(
        'Resource.decodeAll needs a struct described with a type',
      );
      const broken = Dataset.add(data, q(bob, ex('name'), Term.literal('Robert')));
      expect(yield* errorMessage(Resource.decodeAll(Person)(broken))).toBe(
        'Expected exactly one value for <http://example.org/name>, got 2\n  at ["<http://example.org/bob>"]["name"]',
      );
    }),
  );

  it.effect('is a Schema that composes with Schema.decodeTo', () =>
    Effect.gen(function* () {
      const data = Dataset.make(
        q(alice, rdf.type, ex('Person')),
        q(alice, ex('name'), Term.literal('Alice')),
      );
      const PersonResource = Resource.schema(Person);
      const decoded = yield* Schema.decodeEffect(PersonResource)({ dataset: data, subject: alice });
      expect(decoded).toStrictEqual({ id: alice, name: 'Alice', nicks: [] });

      // Compose: a resource decoded to a person, then to their name.
      const NameOf = PersonResource.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((p: typeof Person.Type) => p.name),
          encode: SchemaGetter.transform((name: string) => ({ id: alice, name, nicks: [] })),
        }),
      );
      expect(yield* Schema.decodeEffect(NameOf)({ dataset: data, subject: alice })).toBe('Alice');
      const encoded = yield* Schema.encodeEffect(NameOf)('Alice');
      expect(encoded.subject).toStrictEqual(alice);
      expect(Isomorphism.isomorphic(encoded.dataset, data)).toBe(true);

      expect(
        yield* errorMessage(
          Schema.decodeEffect(PersonResource)({ dataset: Dataset.empty, subject: alice }),
        ),
      ).toBe('Expected <http://example.org/alice> to have rdf:type <http://example.org/Person>');
    }),
  );
});
