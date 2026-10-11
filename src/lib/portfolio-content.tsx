import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { initialContent, normalizePages, type PortfolioContent } from './content-model';

export * from './content-model';

type ContentState = { content: PortfolioContent; previewing: boolean };
const ContentContext = createContext<{
  content: PortfolioContent;
  /** True while an unpublished draft from the Studio is being previewed in this tab. */
  previewing: boolean;
  /** Preview a draft locally (in memory only; nothing is saved). */
  update: (content: PortfolioContent) => void;
  /** Drop any local preview and show the published content again. */
  reset: () => void;
}>({ content: initialContent, previewing: false, update: () => {}, reset: () => {} });

export function ContentProvider({ children, initial = initialContent, version = 0 }: { children: ReactNode; initial?: PortfolioContent; version?: number }) {
  const [state, setState] = useState<ContentState>({ content: initial, previewing: false });
  // A new published version (after a publish or a reload) replaces whatever is shown, including a preview.
  useEffect(() => { setState({ content: initial, previewing: false }); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback((value: PortfolioContent) => setState({ content: { ...value, achievements: normalizePages(value.achievements) }, previewing: true }), []);
  const reset = useCallback(() => setState({ content: initial, previewing: false }), [initial]);
  return <ContentContext.Provider value={{ content: state.content, previewing: state.previewing, update, reset }}>{children}</ContentContext.Provider>;
}
export const usePortfolio = () => useContext(ContentContext);
