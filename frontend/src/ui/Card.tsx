import type { ReactNode } from 'react';

export function Card({
  children,
  padded = false,
  className,
}: {
  children: ReactNode;
  padded?: boolean;
  className?: string;
}) {
  const classes = ['card', padded ? 'card-pad' : '', className ?? ''].filter(Boolean).join(' ');
  return <section className={classes}>{children}</section>;
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="card-header">
      <div>
        <h2 className="card-title">{title}</h2>
        {description ? <p className="card-desc">{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

interface DataListItem {
  label: string;
  value: ReactNode;
}

export function DataList({
  items,
  variant = 'default',
}: {
  items: DataListItem[];
  /** `summary` reads down the right edge, for a quote or a receipt. */
  variant?: 'default' | 'summary';
}) {
  return (
    <dl className={variant === 'summary' ? 'datalist datalist-summary' : 'datalist'}>
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
