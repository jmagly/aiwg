// Issue #3780 metadata; unspecified authors and the SSRN journal DOI are synthetic.
import { crossrefPaper } from './resolve-http.js';

export const exactCases = [
  { title: 'Hamiltonian Neural Networks', year: 2019, arxiv: '1906.01563' },
  { title: 'Extremely randomized trees', year: 2006, doi: '10.1007/s10994-006-6226-1' },
  { title: 'Planning-oriented autonomous driving', year: 2023, doi: '10.1109/cvpr52729.2023.01712' },
  { title: 'Checking Ownership and Confinement', year: 2004, doi: '10.1234/fixture-ownership' },
];

export const pairCases = [
  { title: 'ConTextTab', doi: '10.52202/085713-4918', preprint: '10.48550/arxiv.2506.10707', year: 2025 },
  { title: 'NAVSIM', doi: '10.52202/079017-0902', preprint: '10.48550/arxiv.2406.15349', year: 2024 },
  { title: 'How JEPA avoids noisy features', doi: '10.52202/079017-2897', preprint: '10.48550/arxiv.2407.03475', year: 2024 },
  { title: 'Consumer credit-risk models via machine-learning algorithms', doi: '10.1234/fixture-journal',
    preprint: '10.2139/ssrn.1568864', year: 2010 },
];

export function crossrefPair(pair: typeof pairCases[number], gap = 0) {
  const shared = { title: [pair.title], author: [{ given: 'Ada', family: 'Example' }] };
  return [
    crossrefPaper({ ...shared, DOI: pair.doi, published: { 'date-parts': [[pair.year]] },
      type: pair.doi.startsWith('10.52202/') ? 'proceedings-article' : 'journal-article' }),
    crossrefPaper({ ...shared, DOI: pair.preprint, published: { 'date-parts': [[pair.year - gap]] }, type: 'posted-content' }),
  ];
}
