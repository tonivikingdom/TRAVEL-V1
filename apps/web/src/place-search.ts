import type { PlaceSearchResponse, PlaceSearchResult } from '@travel/contracts';
import { TravelApi, WebError } from './api.js';
import { esc } from './model.js';
import { fieldProblem, showFieldError } from './interactions.js';
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
    this.draft?.query
      .closest('.place-search')
      ?.classList.remove('has-selection');
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
      '<div class="search-controls"><label>地点名称或地址<input data-place-query maxlength="200" autocomplete="off" placeholder="例如：东京站"></label><details class="search-language"><summary>结果语言</summary><label>语言<select data-place-language><option value="ja">日本語</option><option value="zh">中文</option><option value="en">English</option></select></label></details><div class="search-actions"><button type="button" data-place-search>搜索地点</button><button type="button" data-place-cancel>取消搜索</button></div></div><p data-search-status role="status"></p><div data-search-results></div><div data-selected-summary></div><p class="muted">核对地点后，点击“添加地点”加入旅行。</p>';
    form.prepend(section);
    const sources = document.createElement('div');
    sources.className = 'place-sources';
    sources.innerHTML =
      '<button type="button" data-source="search" aria-pressed="true">搜索新地点</button><button type="button" data-source="saved" aria-pressed="false">已保存地点</button>';
    form.prepend(sources);
    const savedLabel = form
      .querySelector<HTMLSelectElement>('[name=place]')!
      .closest('label')!;
    savedLabel.hidden = true;
    sources.querySelectorAll<HTMLButtonElement>('button').forEach(
      (button) =>
        (button.onclick = () => {
          const saved = button.dataset.source === 'saved';
          this.generation++;
          clear();
          section.hidden = saved;
          savedLabel.hidden = !saved;
          sources
            .querySelectorAll('button')
            .forEach((b) =>
              b.setAttribute('aria-pressed', String(b === button)),
            );
        }),
    );
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
        if (
          (event as KeyboardEvent).key === 'Enter' &&
          !(event as KeyboardEvent).isComposing
        ) {
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
      section.classList.remove('has-selection');
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
        const queryInput =
          section.querySelector<HTMLInputElement>('[data-place-query]')!;
        const problem = !query
          ? '请输入地点名称或地址'
          : fieldProblem(queryInput);
        showFieldError(queryInput, problem);
        if (problem) {
          queryInput.focus();
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
            ? '请选择一个地点，核对后再添加。'
            : '没有找到可确认的地点，请换个名称或选择已保存地点。';
          results.innerHTML = response.candidates
            .map(
              (c, i) =>
                `<article class="place-candidate"><strong>${esc(c.name)}</strong><p>${esc(c.formattedAddress ?? '地址待定')}</p>${c.coordinates ? '' : '<p>可靠位置不可用，无法添加或导航。</p>'}<small>${esc(c.attribution)}</small><button type="button" data-candidate="${i}" ${c.coordinates ? '' : 'disabled'}>选择这个地点</button></article>`,
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
                  `<article class="place-candidate selected-place"><p class="eyebrow">已选择 · 尚未添加</p><strong>${esc(candidate.name)}</strong><p>${esc(candidate.formattedAddress ?? '地址待定')}</p><details><summary>地点来源与位置</summary><p>${candidate.coordinates!.latitude}, ${candidate.coordinates!.longitude}</p><small>${esc(candidate.attribution)}</small></details><button type="button" data-place-change>更换地点</button></article>`;
                section.classList.add('has-selection');
                section.querySelector<HTMLButtonElement>(
                  '[data-place-change]',
                )!.onclick = () => {
                  this.generation++;
                  clear();
                  status.textContent = '请重新搜索并选择地点。';
                  section
                    .querySelector<HTMLInputElement>('[data-place-query]')!
                    .focus();
                };
                select.querySelector('[data-searched-place]')?.remove();
                const option = new Option(
                  `搜索候选 · ${candidate.name} · ${candidate.formattedAddress ?? '地址待定'}`,
                  `search:${candidate.selectionToken}`,
                );
                option.dataset.searchedPlace = 'true';
                select.add(option);
                select.value = option.value;
                status.textContent = '尚未加入旅行。';
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
