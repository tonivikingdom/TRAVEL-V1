import { Theme } from './settings/types';
import { GeneratedComponent } from './components/desktop/DesktopPreview';
import './desktop-layout.css';

const theme: Theme = 'light';

function App() {
  function setTheme(theme: Theme) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  setTheme(theme);

  return (
    <>
      <GeneratedComponent />
    </>
  ); // %EXPORT_STATEMENT%
}

export default App;
