// Offline HTTP fixture for the real research clients, including retries and exact namespaces.
import fixture from './resolve-papers.json';
import type { CrossRefResponse, SemanticScholarResponse } from '../../../src/research/types.js';

export const s2Paper = (overrides: Partial<SemanticScholarResponse> = {}): SemanticScholarResponse => ({ ...structuredClone(fixture.s2), ...overrides });
export const crossrefPaper = (overrides: Partial<CrossRefResponse> = {}): CrossRefResponse => ({ ...structuredClone(fixture.crossref), ...overrides });

export interface HttpFixture {
  s2: SemanticScholarResponse[];
  arxiv: Array<{ id: string; title: string; year?: number }>;
  crossref: CrossRefResponse[];
  errors: Partial<Record<'s2' | 'arxiv' | 'crossref', number>>;
  idTitle: string;
}

export function httpFixture(): HttpFixture {
  return { s2: [s2Paper()], arxiv: [], crossref: [], errors: {}, idTitle: fixture.s2.title };
}

const xml = (papers: HttpFixture['arxiv']): string => `<feed>${papers.map(p => `<entry>
  <id>https://arxiv.org/abs/${p.id}</id><title>${p.title}</title><summary>Fixture abstract</summary>
  <published>${p.year ?? 2024}-02-03T00:00:00Z</published><author><name>Ada Example</name></author>
  <link title="pdf" href="https://arxiv.org/pdf/${p.id}.pdf"/>
  </entry>`).join('')}</feed>`;

export function fixtureFetch(state: HttpFixture): (input: string | URL | Request) => Promise<Response> {
  return async input => {
    const url = new URL(String(input));
    const source = url.hostname === 'api.semanticscholar.org' ? 's2' : url.hostname === 'export.arxiv.org' ? 'arxiv' : url.hostname === 'api.crossref.org' ? 'crossref' : undefined;
    if (!source) throw new Error(`Unexpected HTTP host in offline fixture: ${url.hostname}`);
    if (state.errors[source]) return new Response('', { status: state.errors[source] });
    if (source === 'arxiv') {
      if (url.pathname !== '/api/query') throw new Error('arXiv namespace lost');
      const id = url.searchParams.get('id_list');
      return new Response(xml(id ? [{ id: `${id}v4`, title: state.idTitle }] : state.arxiv));
    }
    if (source === 'crossref') {
      if (url.pathname === '/works') {
        if (!url.searchParams.has('query.bibliographic')) throw new Error('Expected query.bibliographic');
        return Response.json({ message: { 'total-results': state.crossref.length, items: state.crossref } });
      }
      if (!url.pathname.startsWith('/works/')) throw new Error('CrossRef namespace lost');
      return Response.json({ message: crossrefPaper({ DOI: decodeURIComponent(url.pathname.slice(7)), title: [state.idTitle] }) });
    }
    if (!url.pathname.startsWith('/graph/v1/paper/')) throw new Error('S2 graph namespace lost');
    if (url.pathname === '/graph/v1/paper/search/match') return Response.json({ data: state.s2 });
    const id = decodeURIComponent(url.pathname.slice('/graph/v1/paper/'.length));
    const paper = s2Paper({ title: state.idTitle, externalIds: {} });
    if (id.startsWith('ARXIV:')) paper.externalIds = { ArXiv: id.slice(6) };
    else if (id.startsWith('DOI:')) paper.externalIds = { DOI: id.slice(4) };
    else if (id.startsWith('ACL:')) paper.externalIds = { ACL: id.slice(4) };
    else if (/^[a-f\d]{40}$/i.test(id)) paper.paperId = id;
    return Response.json(paper);
  };
}
