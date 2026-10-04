import type { PlaceSearchResponse, PlaceSearchResult } from '@travel/contracts';
import { TravelApi, WebError } from './api.js';
import { esc } from './model.js';
/** Local candidate UI; only the authoring submit performs a formal write. */
export class PlaceSearchPicker {
  private selected: PlaceSearchResult | null = null;
  private generation = 0;
  private draft: {
    query: HTMLInputElement;
    language: HTMLSelectElement;
  } | null = null;
  private baseline: string | null = null;
  constructor(private readonly api: TravelApi) {}
  clearSelection() {
    this.selected = null;
    this.generation++;
  }
  reset() {
    this.clearSelection();
    this.draft = null;
    this.baseline = null;
  }
  get snapshot() {
    return this.draft?.query.isConnected
      ? JSON.stringify([this.draft.query.value, this.draft.language.value])
      : null;
  }
  get dirty() {
    return this.snapshot !== null && this.snapshot !== this.baseline;
  }
  acknowledge(snapshot: string | null) {
    this.baseline = snapshot;
  }
  get candidate() {
    return this.selected;
  }
  selection(form: HTMLFormElement) {
    return (form.elements.namedItem('place') as HTMLSelectElement | null)
      ?.value === `search:${this.selected?.selectionToken}`
      ? this.selected
      : null;
  }
  mount(
    form: HTMLFormElement,
    tripId: string,
    changed: () => void,
    failed: (error: unknown) => void,
  ) {
    this.reset();
    const section = document.createElement('section');
    section.className = 'place-search';
    section.innerHTML =
      '<h3>搜索新地点</h3><label>地点名称或地址<input data-place-query maxlength="200" autocomplete="off" placeholder="例如：东京站"></label><label>结果语言<select data-place-language><option value="ja">日本語</option><option value="zh">中文</option><option value="en">English</option></select></label><button type="button" data-place-search>搜索地点</button><button type="button" data-place-cancel>取消搜索</button><p data-search-status role="status"></p><div data-search-results></div><div data-selected-summary></div><p class="muted">搜索和选择不会保存地点。核对后点击下方“添加地点”才加入旅行。</p>';
    form.prepend(section);
    this.draft = {
      query: section.querySelector<HTMLInputElement>('[data-place-query]')!,
      language: section.querySelector<HTMLSelectElement>(
        '[data-place-language]',
      )!,
    };
    this.baseline = this.snapshot;
    const initialQuery = this.draft.query.value;
    const initialLanguage = this.draft.language.value;
    const status = section.querySelector('[data-search-status]')!;
    const results = section.querySelector('[data-search-results]')!;
    const select = form.elements.namedItem('place') as HTMLSelectElement;
    const searchButton = section.querySelector(
      '[data-place-search]',
    ) as HTMLButtonElement;
    section
      .querySelector('[data-place-query]')!
      .addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          event.preventDefault();
          searchButton.click();
        }
      });
    select.addEventListener('change', () => {
      const searched = select.value.startsWith('search:');
      (section.querySelector('[data-selected-summary]') as HTMLElement).hidden =
        !searched;
      const note = form.elements.namedItem(
        'note',
      ) as HTMLTextAreaElement | null;
      if (note) note.maxLength = searched ? 1200 : 2000;
    });
    const clear = () => {
      this.selected = null;
      const note = form.elements.namedItem(
        'note',
      ) as HTMLTextAreaElement | null;
      if (note) note.maxLength = 2000;
      select.querySelector('[data-searched-place]')?.remove();
      results.innerHTML = '';
      section.querySelector('[data-selected-summary]')!.innerHTML = '';
      changed();
    };
    section
      .querySelector('[data-place-cancel]')!
      .addEventListener('click', () => {
        this.generation++;
        // Discard only the local search. Note/saved-place dirtiness belongs to authoring.
        section.querySelector<HTMLInputElement>('[data-place-query]')!.value =
          initialQuery;
        section.querySelector<HTMLSelectElement>(
          '[data-place-language]',
        )!.value = initialLanguage;
        this.baseline = this.snapshot;
        clear();
        status.textContent = '已取消搜索，未保存地点或修改旅行。';
        (
          section.querySelector('[data-place-search]') as HTMLButtonElement
        ).disabled = false;
      });
    section
      .querySelector('[data-place-search]')!
      .addEventListener('click', async () => {
        const query = (
          section.querySelector('[data-place-query]') as HTMLInputElement
        ).value.trim();
        if (!query) {
          status.textContent = '请输入地点名称或地址。';
          return;
        }
        const epoch = ++this.generation;
        clear();
        status.textContent = '正在搜索…';
        const button = section.querySelector(
          '[data-place-search]',
        ) as HTMLButtonElement;
        button.disabled = true;
        try {
          const response = await this.api.request<PlaceSearchResponse>(
            `/trips/${tripId}/place-search`,
            {
              query,
              language: (
                section.querySelector(
                  '[data-place-language]',
                ) as HTMLSelectElement
              ).value,
            },
          );
          if (epoch !== this.generation || !section.isConnected) return;
          status.textContent = response.candidates.length
            ? '请核对名称、地址和坐标，明确选择一个候选。'
            : '没有找到可确认的地点，请换个名称或选择已保存地点。';
          results.innerHTML = response.candidates
            .map(
              (c, i) =>
                `<article class="place-candidate"><strong>${esc(c.name)}</strong><p>${esc(c.formattedAddress ?? '地址待定')}</p><p>${c.coordinates ? `${c.coordinates.latitude}, ${c.coordinates.longitude}` : '可靠坐标不可用，不能用于导航或加入地点'}</p><small>${esc(c.attribution)}</small><button type="button" data-candidate="${i}" ${c.coordinates ? '' : 'disabled'}>选择这个地点</button></article>`,
            )
            .join('');
          results
            .querySelectorAll<HTMLButtonElement>('[data-candidate]')
            .forEach((b) =>
              b.addEventListener('click', () => {
                const candidate =
                  response.candidates[Number(b.dataset.candidate)]!;
                this.selected = candidate;
                (
                  section.querySelector(
                    '[data-selected-summary]',
                  ) as HTMLElement
                ).hidden = false;
                const note = form.elements.namedItem(
                  'note',
                ) as HTMLTextAreaElement | null;
                if (note) note.maxLength = 1200;
                section.querySelector('[data-selected-summary]')!.innerHTML =
                  `<article class="place-candidate"><p>已选择 · 尚未加入旅行</p><p>备注最多 1200 字，地点来源信息将随安排保留。</p><strong>${esc(candidate.name)}</strong><p>${esc(candidate.formattedAddress ?? '地址待定')}</p><p>${candidate.coordinates!.latitude}, ${candidate.coordinates!.longitude}</p><small>${esc(candidate.attribution)}</small></article>`;
                select.querySelector('[data-searched-place]')?.remove();
                const option = new Option(
                  `搜索候选 · ${candidate.name} · ${candidate.formattedAddress ?? '地址待定'}`,
                  `search:${candidate.selectionToken}`,
                );
                option.dataset.searchedPlace = 'true';
                select.add(option);
                select.value = option.value;
                status.textContent = `已选择：${candidate.name}。尚未加入旅行，请核对并点击“添加地点”。`;
                results
                  .querySelectorAll('[data-candidate]')
                  .forEach((v) =>
                    v.setAttribute('aria-pressed', String(v === b)),
                  );
                changed();
              }),
            );
        } catch (error) {
          if (epoch === this.generation && section.isConnected) {
            if (
              error instanceof WebError &&
              error.code !== 'PLACE_SEARCH_UNAVAILABLE'
            ) {
              button.disabled = false;
              failed(error);
              return;
            }
            status.textContent = '地点搜索暂时不可用，仍可选择已保存地点。';
          }
        } finally {
          if (epoch === this.generation) {
            // If authoring owns the busy state, restore this completed read as enabled afterwards.
            if (button.dataset.wasDisabled !== undefined)
              button.dataset.wasDisabled = 'false';
            else button.disabled = false;
          }
        }
      });
  }
}
