import { Star } from '@phosphor-icons/react';

export interface StarsProps {
  /** 0..5; null = never rated. */
  value: number | null;
  onRate: (value: number) => void;
}

/** Five duotone stars, lit up to the rating. Clicking the lit top star sets 0 (a real "0 of 5", not "unrated"). */
export function Stars({ value, onRate }: StarsProps) {
  return (
    <div className="mv-stars" role="group" aria-label={value === null ? 'Rating: not rated' : `Rating: ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => {
        const lit = value !== null && n <= value;
        const label = value === n ? `Rated ${n} of 5 (click for 0)` : `Rate ${n} of 5`;
        return (
          <button
            key={n}
            type="button"
            className={lit ? 'mv-star on' : 'mv-star'}
            data-tip={label}
            data-tip-side="below"
            aria-label={label}
            aria-pressed={lit}
            onClick={() => onRate(value === n ? 0 : n)}
          >
            <Star weight="duotone" />
          </button>
        );
      })}
      <span className="mv-stars-n">{value === null ? 'unrated' : `${value}/5`}</span>
    </div>
  );
}
