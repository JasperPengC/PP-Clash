import { useId } from 'react';

/** 纯猫头标志：无背景色，颜色跟随 currentColor，自动适配明暗主题。 */
export function BrandCat({ size = 30, className = '' }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  const mask = `cat-holes-${id}`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="192 186 640 640"
      aria-hidden="true"
      style={{ color: 'var(--text-1)' }}
    >
      <defs>
        <mask id={mask}>
          <path
            d="M512 376 C540 376 566 380 588 390 C616 362 640 306 676 252 C688 246 700 252 704 268 C712 296 728 368 746 428 C758 472 772 516 772 572 C772 648 676 756 512 756 C348 756 252 648 252 572 C252 516 266 472 278 428 C296 368 312 296 320 268 C324 252 336 246 348 252 C384 306 408 362 436 390 C458 380 484 376 512 376 Z"
            fill="#fff"
          />
          <circle cx="413" cy="545" r="34" fill="#000" />
          <circle cx="611" cy="545" r="34" fill="#000" />
          <circle cx="424" cy="534" r="11" fill="#fff" />
          <circle cx="622" cy="534" r="11" fill="#fff" />
          <path d="M488 606 L536 606 L512 638 Z" fill="#000" stroke="#000" strokeWidth="16" strokeLinejoin="round" />
          <g fill="none" stroke="#000" strokeWidth="12" strokeLinecap="round">
            <path d="M512 648 L512 660" />
            <path d="M482 660 A15 15 0 0 0 512 660" />
            <path d="M512 660 A15 15 0 0 0 542 660" />
          </g>
          <g fill="none" stroke="#000" strokeWidth="10" strokeLinecap="round">
            <path d="M298 588 Q338 598 374 595" />
            <path d="M288 628 Q332 638 370 633" />
            <path d="M297 667 Q337 676 371 669" />
            <path d="M726 588 Q686 598 650 595" />
            <path d="M736 628 Q692 638 654 633" />
            <path d="M727 667 Q687 676 653 669" />
          </g>
        </mask>
      </defs>
      <rect x="0" y="0" width="1024" height="1024" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}
