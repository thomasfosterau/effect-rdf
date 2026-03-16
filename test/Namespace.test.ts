/**
 * Tests for Namespace module.
 */
import { describe, it, expect } from "bun:test"
import { Equal } from "effect"
import * as NS from "../src/Namespace.js"

describe("Namespace", () => {
  describe("namespace factory", () => {
    it("creates IRIs by appending local names", () => {
      const ex = NS.namespace("https://example.org/")
      const iri = ex("Person")
      expect(iri.value).toBe("https://example.org/Person")
    })

    it("works with hash-based namespaces", () => {
      const ex = NS.namespace("https://example.org/vocab#")
      expect(ex("term").value).toBe("https://example.org/vocab#term")
    })
  })

  describe("rdf namespace", () => {
    it("produces correct rdf:type IRI", () => {
      expect(NS.rdf("type").value).toBe(
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
      )
    })

    it("RDF convenience constants match namespace calls", () => {
      expect(Equal.equals(NS.RDF.type, NS.rdf("type"))).toBe(true)
    })
  })

  describe("rdfs namespace", () => {
    it("produces correct rdfs:label IRI", () => {
      expect(NS.rdfs("label").value).toBe("http://www.w3.org/2000/01/rdf-schema#label")
    })

    it("RDFS convenience constants match namespace calls", () => {
      expect(Equal.equals(NS.RDFS.subClassOf, NS.rdfs("subClassOf"))).toBe(true)
    })
  })

  describe("xsd namespace", () => {
    it("produces correct xsd:string IRI", () => {
      expect(NS.xsd("string").value).toBe("http://www.w3.org/2001/XMLSchema#string")
    })

    it("XSD constants match namespace calls", () => {
      expect(Equal.equals(NS.XSD.integer, NS.xsd("integer"))).toBe(true)
    })
  })

  describe("owl namespace", () => {
    it("produces correct owl:Class IRI", () => {
      expect(NS.owl("Class").value).toBe("http://www.w3.org/2002/07/owl#Class")
    })

    it("OWL constants match namespace calls", () => {
      expect(Equal.equals(NS.OWL.equivalentClass, NS.owl("equivalentClass"))).toBe(true)
    })
  })

  describe("schema namespace", () => {
    it("produces https-based schema.org IRIs", () => {
      expect(NS.schema("Person").value).toBe("https://schema.org/Person")
    })

    it("SCHEMA constants match namespace calls", () => {
      expect(Equal.equals(NS.SCHEMA.Person, NS.schema("Person"))).toBe(true)
    })
  })

  describe("foaf namespace", () => {
    it("FOAF.Person matches foaf(Person)", () => {
      expect(Equal.equals(NS.FOAF.Person, NS.foaf("Person"))).toBe(true)
    })
  })

  describe("dcterms namespace", () => {
    it("DCTERMS.title matches dcterms(title)", () => {
      expect(Equal.equals(NS.DCTERMS.title, NS.dcterms("title"))).toBe(true)
    })
  })

  describe("skos namespace", () => {
    it("SKOS.prefLabel matches skos(prefLabel)", () => {
      expect(Equal.equals(NS.SKOS.prefLabel, NS.skos("prefLabel"))).toBe(true)
    })
  })
})
