// Dev-only UI plumbing test page at `#/__test/ui` (story 2.3). Drives the announcer and the
// toast for Playwright. Never shipped: App.tsx loads it only under import.meta.env.DEV. Not
// user-facing, so its text is not in ui/strings.ts.

import { useState } from 'react';
import { announce } from '../ui/a11y/announcer';
import { showToast } from '../ui/toast';

export default function UiTestPage() {
  const [result, setResult] = useState('');
  return (
    <div>
      <h1>UI test page</h1>
      <button type="button" onClick={() => announce('Polite test message')}>
        Announce polite
      </button>
      <button type="button" onClick={() => announce('Assertive test message', 'assertive')}>
        Announce assertive
      </button>
      <button type="button" onClick={() => showToast({ message: 'Toast test message' })}>
        Show toast
      </button>
      {/* Last on the page, so the next Tab after clicking it reaches the toast's action. */}
      <button
        type="button"
        onClick={() =>
          showToast({
            message: 'Toast with action',
            action: { label: 'Undo', run: () => setResult('Action ran') },
          })
        }
      >
        Show toast with action
      </button>
      <p data-testid="toast-action-result">{result}</p>
    </div>
  );
}
