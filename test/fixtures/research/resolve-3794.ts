// Offline issue #3794 metadata; runner-up identities and unspecified authors are synthetic.
import { crossrefPaper, s2Paper } from './resolve-http.js';

export const trees = {
  title: 'Extremely randomized trees', year: 2006, doi: '10.1007/s10994-006-6226-1',
};
export const planning = {
  title: 'Planning-oriented autonomous driving', year: 2022, venueYear: 2023,
  arxiv: '2212.10156', doi: '10.1109/cvpr52729.2023.01712',
};
export const control = { title: 'Applied optimal control', year: 1971, suppliedYear: 1975 };

export const treesRecords = () => [
  crossrefPaper({ title: [trees.title], DOI: trees.doi, published: { 'date-parts': [[trees.year]] } }),
  crossrefPaper({ title: [`${trees.title} models`], DOI: '10.1234/fixture-chapter',
    published: { 'date-parts': [[2021]] }, type: 'book-chapter' }),
];
export const planningRecord = () => s2Paper({ title: planning.title, year: planning.year,
  publicationDate: '2023-06-01', venue: 'CVPR', externalIds: { ArXiv: planning.arxiv, DOI: planning.doi } });
export const distantRunner = () => s2Paper({ title: 'Autonomous driving models', year: 2021,
  paperId: 'b'.repeat(40), externalIds: {} });
