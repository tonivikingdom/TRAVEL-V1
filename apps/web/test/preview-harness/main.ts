import {
  previewMarkup,
  previewPresentation,
} from '../../src/preview-presentation.js';
import {
  previewCases,
  previewFixture,
  type PreviewCase,
} from '../preview-fixture.js';
import '../../src/styles.css';
import '../../src/preview-presentation.css';
import './style.css';
const requested = new URLSearchParams(location.search).get('case');
const kind = previewCases.includes(requested as PreviewCase)
  ? (requested as PreviewCase)
  : 'full';
const fixture = previewFixture(kind);
const root = document.querySelector('#harness')!;
root.innerHTML = `<p class="harness-label">SYNTHETIC · 独立展示验收 · ${kind}</p><article>${previewMarkup(previewPresentation(fixture.preview, kind === 'unknown' ? null : fixture.trip))}<p class="muted">只有明确采用才会修改正式行程。</p></article>`;
