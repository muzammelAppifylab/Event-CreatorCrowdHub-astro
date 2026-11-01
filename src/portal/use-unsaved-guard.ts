import {useBlocker} from '@tanstack/react-router';
import {useEffect, useRef} from 'react';

import {useConfirm} from './ui';

/**
 * Leave-without-saving guard: while `dirty`, closing the tab asks the browser's own prompt and an
 * in-app navigation asks the kit's confirm dialog. Call the returned `allowNext()` right before a
 * navigation that follows a successful save, so it is never blocked.
 */
export function useUnsavedGuard(dirty: boolean) {
  const confirm = useConfirm();
  const allow = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !allow.current,
    enableBeforeUnload: () => dirty && !allow.current,
    withResolver: true,
  });

  useEffect(() => {
    if (blocker.status !== 'blocked') return;
    void confirm({
      title: 'Leave without saving?',
      body: 'Your changes to this event have not been saved. If you leave now, they are lost.',
      confirmLabel: 'Leave without saving',
    }).then(ok => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker, confirm]);

  return {
    allowNext: () => {
      allow.current = true;
    },
  };
}
