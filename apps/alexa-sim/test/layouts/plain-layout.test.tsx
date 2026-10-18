// @vitest-environment jsdom
import { PlainLayout } from '../../src/layouts/plain/PlainLayout.js';
import { describeSurfaceLayoutContract } from '../surface/surface-layout-contract.js';

describeSurfaceLayoutContract('plain', PlainLayout);
