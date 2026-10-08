// Registry of all 10 cases (PRD: 10 fixed case templates).
import { definition as openingNight } from './opening-night.mjs';
import { buildSkeletonA } from './skeleton-a.mjs';
import { THEMES } from './themes.mjs';

export const DEFINITIONS = [openingNight, ...THEMES.map(buildSkeletonA)];
