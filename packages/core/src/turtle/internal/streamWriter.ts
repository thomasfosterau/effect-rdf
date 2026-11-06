/**
 * An incremental Turtle / TriG writer.
 *
 * @internal
 */
import * as Term from '../../Term.ts';
import { rdf } from '../../Vocab.ts';
import * as Lexical from '../../ntriples/Lexical.ts';
import * as Arr from 'effect/Array';
import * as Iterable from 'effect/Iterable';
import * as Option from 'effect/Option';
import { byPrefixName, checkQuad, isPrefixName, Writer, type WriterOptions } from './writer.ts';

/**
 * Groups consecutive statements by graph, subject and predicate but performs
 * no look-ahead (no inline blank nodes, lists or annotations), so it runs in
 * constant memory.
 *
 * @internal
 */
export class StreamWriter {
  private writerInstance: Option.Option<Writer> = Option.none();
  /** The keys of the open graph block, statement and predicate. */
  private graph: Option.Option<string> = Option.none();
  private subject: Option.Option<string> = Option.none();
  private predicate: Option.Option<string> = Option.none();
  private started = false;

  readonly options: WriterOptions;
  constructor(options: WriterOptions) {
    this.options = options;
  }

  /** Created lazily so that option validation errors surface as failures. */
  private get writer(): Writer {
    if (Option.isSome(this.writerInstance)) return this.writerInstance.value;
    const writer = new Writer({ ...this.options, autoPrefixes: false }, [], false);
    this.writerInstance = Option.some(writer);
    return writer;
  }

  /** The document header: base and all declared prefixes. */
  private header(): string {
    void this.writer;
    const sparql = this.options.sparqlDirectives;
    const base = Option.match(this.options.baseIri, {
      onNone: () => '',
      onSome: (iri) => {
        const escaped = Term.escapeIri(iri);
        return sparql ? `BASE <${escaped}>\n` : `@base <${escaped}> .\n`;
      },
    });
    const prefixes = Option.match(this.options.prefixes, {
      onNone: () => '',
      onSome: (map) =>
        Arr.sort(
          Arr.filter(
            Arr.fromIterable(map.prefixes),
            ([p, ns]) => isPrefixName(p) && Lexical.isWritableIri(ns),
          ),
          byPrefixName,
        )
          .map(([p, ns]) => {
            const iri = Term.escapeIri(ns);
            return sparql ? `PREFIX ${p}: <${iri}>\n` : `@prefix ${p}: <${iri}> .\n`;
          })
          .join(''),
    });
    const out = base + prefixes;
    return out === '' ? '' : `${out}\n`;
  }

  write(quads: Iterable<Term.Quad>): string {
    let out = '';
    if (!this.started) {
      this.started = true;
      out += this.header();
    }
    const indent = this.options.indent;
    const writer = this.writer;
    Iterable.forEach(quads, (q) => {
      checkQuad(q, this.options.trig);
      const graph = q.graph.key;
      if (Option.isNone(this.graph) || this.graph.value !== graph) {
        out += this.closeGraph();
        this.graph = Option.some(graph);
        if (!Term.isDefaultGraph(q.graph)) out += `${writer.term(q.graph)} {\n`;
      }
      const pad = Term.isDefaultGraph(q.graph) ? '' : indent;
      const object = writer.term(q.object);
      if (Option.isSome(this.subject) && this.subject.value === q.subject.key) {
        if (Option.isSome(this.predicate) && this.predicate.value === q.predicate.key) {
          out += `, ${object}`;
        } else {
          this.predicate = Option.some(q.predicate.key);
          out += ` ;\n${pad}${indent}${this.verb(q.predicate)} ${object}`;
        }
      } else {
        if (Option.isSome(this.subject)) out += ' .\n';
        this.subject = Option.some(q.subject.key);
        this.predicate = Option.some(q.predicate.key);
        out += `${pad}${writer.term(q.subject)} ${this.verb(q.predicate)} ${object}`;
      }
    });
    return out;
  }

  /** Closes any open statement and graph block. */
  end(): string {
    const head = this.started ? '' : this.header();
    this.started = true;
    return head + this.closeGraph();
  }

  private verb(p: Term.NamedNode): string {
    return p.value === rdf.type.value ? 'a' : this.writer.iri(p.value);
  }

  private closeGraph(): string {
    let out = '';
    if (Option.isSome(this.subject)) out += ' .\n';
    this.subject = Option.none();
    this.predicate = Option.none();
    if (Option.isSome(this.graph) && this.graph.value !== '') out += '}\n';
    this.graph = Option.none();
    return out;
  }
}
