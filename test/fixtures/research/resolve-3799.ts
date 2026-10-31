// Offline Ridge regression reprint pair; the runner-up DOI is a synthetic identity.
import { crossrefPaper } from './resolve-http.js';

export const ridge = {
  title: 'Ridge regression: Biased estimation for nonorthogonal problems',
  year: 1970, doi: '10.1080/00401706.1970.10488634',
};

export const ridgeRecords = () => [1970, 2000].map(year => crossrefPaper({
  title: [ridge.title], DOI: year === ridge.year ? ridge.doi : '10.1234/fixture-ridge-reprint',
  author: [{ given: 'Arthur E.', family: 'Hoerl' }, { given: 'Robert W.', family: 'Kennard' }],
  published: { 'date-parts': [[year]] }, type: 'journal-article',
}));
