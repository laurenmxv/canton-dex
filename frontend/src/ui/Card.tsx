import type { ReactNode } from 'react';

export function Card({ children, padded = false }: { children: ReactNode; padded?: boolean }) {
  return <section className={`card ${padded ? 'card-pad' : ''}`.trim()}>{children}</section>;
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

export function DataList({ items }: { items: DataListItem[] }) {
  return (
    <dl className="datalist">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
