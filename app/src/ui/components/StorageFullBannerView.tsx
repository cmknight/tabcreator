import { strings } from '../strings';
import banner from './banner.module.css';
import buttons from './buttons.module.css';
import { ErrorIcon } from './icons';
import styles from './StorageFullBannerView.module.css';

export interface StorageFullBannerViewProps {
  /** The banner's sentence. */
  text: string;
  /** Classes added to the shared error banner's (the screen's spacing). */
  className?: string | undefined;
  testId: string;
  /**
   * Whether the "Go to Library" link shows; true when absent. The Library's own banner has none
   * (EXPERIENCE.md: no action on the Library itself).
   */
  link?: boolean | undefined;
  /** A Retry button after the Library link, when given. */
  retry?: { label: string; onClick(): void };
}

/**
 * The storage-full error banner's markup (DESIGN.md banner-error, CAP-25): the error icon, the
 * text, a link to the Library (where takes or their audio can be deleted; unless `link` is false)
 * and an optional Retry; no Dismiss; no role (not a live region, AD-18). Presentational only:
 * Record's `StorageFullBanner`, the Tab screen's failure banner and the Library's banner each
 * choose the text and announce it.
 */
export function StorageFullBannerView({
  text,
  className,
  testId,
  link = true,
  retry,
}: StorageFullBannerViewProps) {
  return (
    <div
      className={[banner.banner, banner.error, className].filter(Boolean).join(' ')}
      data-testid={testId}
    >
      <ErrorIcon className={banner.icon} />
      <p className={banner.text}>{text}</p>
      {link && (
        <a className={styles.link} href="#/library">
          {strings['global.goToLibrary']}
        </a>
      )}
      {retry && (
        <button type="button" className={buttons.secondary} onClick={retry.onClick}>
          {retry.label}
        </button>
      )}
    </div>
  );
}
