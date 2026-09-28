import { configure } from '@testing-library/react';

// Whole-app tests wait for several API answers before a page appears. On a loaded runner (the
// whole monorepo's tests at once) that can pass the default 1 s, so `findBy*` waits up to 5 s.
configure({ asyncUtilTimeout: 5000 });
