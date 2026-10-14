import { useSyncExternalStore } from 'react';
import { GeneratedComponent as OriginalHome } from '../generated/GeneratedComponent';
import { DesktopHome } from './DesktopHome';
import '../../desktop-details.css';

const desktopQuery = window.matchMedia('(min-width: 960px)');
const subscribe = (onChange: () => void) => {
  desktopQuery.addEventListener('change', onChange);
  return () => desktopQuery.removeEventListener('change', onChange);
};
const getSnapshot = () => desktopQuery.matches;
export function GeneratedComponent() {
  const desktop = useSyncExternalStore(subscribe, getSnapshot);
  return desktop ? <DesktopHome /> : <OriginalHome />;
}
