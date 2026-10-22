/**
 * An incremental Turtle / TriG writer.
 *
 * @internal
 */
import * as Term from '@thomasfosterau/effect-rdf/Term';
import * as Arr from 'effect/Array';
import { rdf } from '@thomasfosterau/effect-rdf/Vocab';
import * as Lexical from '@thomasfosterau/effect-ntriples/Lexical';
import { byPrefixName, checkQuad, isPrefixName, Writer, type WriterOptions } from './writer.ts';

/**
 * Groups consecutive statements by graph, subject and predicate but performs
 * no look-ahead (no inline blank nodes, lists or annotations), so it runs in
 * constant memory.
 *
 * @internal
 */
export class StreamWriter {
  private writerInstance: Writer | undefined;
  private graph: string | undefined;
  private subject: string | undefined;
  private predicate: string | undefined;
  private started = false;

  readonly options: WriterOptions;
  constructor(options: WriterOptions) {
    this.options = options;
  }

  /** Created lazily so that option validation errors surface as failures. */
  private get writer(): Writer {
    return (this.writerInstance ??= new Writer(
      { ...this.options, autoPrefixes: false },
      [],
      false,
    ));
  }

  /** The document header: base and all declared prefixes. */
  private header(): string {
    let out = '';
    void this.writer;
    const sparql = this.options.sparqlDirectives;
    if (this.options.baseIri !== undefined) {
      const base = Term.escapeIri(this.options.baseIri);
      out += sparql ? `BASE <${base}>\n` : `@base <${base}> .\n`;
    }
    if (this.options.prefixes !== undefined) {
      const prefixes = Arr.sort(
        Array.from(this.options.prefixes.prefixes).filter(
          ([p, ns]) => isPrefixName(p) && Lexical.isWritableIri(ns),
        ),
        byPrefixName,
      );
      for (const [p, ns] of prefixes) {
        const iri = Term.escapeIri(ns);
        out += sparql ? `PREFIX ${p}: <${iri}>\n` : `@prefix ${p}: <${iri}> .\n`;
      }
    }
    return out === '' ? '' : `${out}\n`;
  }

  write(quads: Iterable<Term.Quad>): string {
    let out = '';
    if (!this.started) {
      this.started = true;
      out += this.header();
    }
    const indent = this.options.indent;
    for (const q of quads) {
      checkQuad(q, this.options.trig);
      const graph = q.graph.key;
      if (graph !== this.graph) {
        out += this.closeGraph();
        this.graph = graph;
        if (q.graph._tag !== 'DefaultGraph') out += `${this.writer.term(q.graph)} {\n`;
      }
      const pad = q.graph._tag === 'DefaultGraph' ? '' : indent;
      const object = this.writer.term(q.object);
      if (q.subject.key === this.subject) {
        if (q.predicate.key === this.predicate) {
          out += `, ${object}`;
        } else {
          this.predicate = q.predicate.key;
          out += ` ;\n${pad}${indent}${this.verb(q.predicate)} ${object}`;
        }
      } else {
        if (this.subject !== undefined) out += ' .\n';
        this.subject = q.subject.key;
        this.predicate = q.predicate.key;
        out += `${pad}${this.writer.term(q.subject)} ${this.verb(q.predicate)} ${object}`;
      }
    }
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
    if (this.subject !== undefined) out += ' .\n';
    this.subject = undefined;
    this.predicate = undefined;
    if (this.graph !== undefined && this.graph !== '') out += '}\n';
    this.graph = undefined;
    return out;
  }
}
