import '../../src/styles.css';
import '../../src/interactions.css';
import './style.css';
import {
  installInteractions,
  confirmAction,
  validateForm,
} from '../../src/interactions.js';
installInteractions();
const form = document.querySelector('form')!;
const input = form.querySelector('input')!;
const title = document.querySelector<HTMLButtonElement>('.card-open')!;
const menu = document.querySelector<HTMLElement>('.review-menu')!;
const opener = document.querySelector<HTMLButtonElement>('.mobile-menu')!;
const status = document.querySelector('[role=status]')!;
function closeMenu() {
  menu.hidden = true;
  opener.setAttribute('aria-expanded', 'false');
}
opener.onclick = () => {
  menu.hidden = !menu.hidden;
  opener.setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) menu.querySelector('button')!.focus();
};
document.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button) return;
  if (button.hasAttribute('data-rename')) {
    closeMenu();
    form.hidden = false;
    input.value = title.textContent!;
    input.focus();
  }
  if (button.hasAttribute('data-cancel')) {
    form.hidden = true;
    opener.focus();
  }
  if (button.hasAttribute('data-share')) {
    closeMenu();
    status.textContent = 'DEPENDENCY：公开分享未实现，没有生成链接。';
  }
  if (button.hasAttribute('data-delete')) {
    closeMenu();
    await confirmAction(
      `「${title.textContent}」：此夹具仅演示删除确认，真实删除范围与恢复条件等待服务契约。`,
      '演示删除确认',
      '保留旅行',
    );
    status.textContent = 'SYNTHETIC 演示完成，未删除任何数据。';
  }
  if (button === title)
    status.textContent = 'SYNTHETIC 卡片主体入口；没有真实旅行。';
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if ((event as SubmitEvent).isTrusted && validateForm(form)) {
    title.textContent = input.value.trim();
    form.hidden = true;
    status.textContent = 'SYNTHETIC 演示名称已更新，未持久化。';
  }
});
input.addEventListener('keydown', (event) => {
  if (event.isComposing && event.key === 'Enter') event.preventDefault();
  if (event.key === 'Escape') {
    event.stopPropagation();
    form.hidden = true;
    opener.focus();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menu.hidden) {
    closeMenu();
    opener.focus();
  }
});
