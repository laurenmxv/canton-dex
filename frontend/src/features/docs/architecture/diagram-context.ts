import { createContext } from 'react';

/** What a box can do on click: a layer card opens its view. */
export const DiagramContext = createContext<{ onLayer: (id: string) => void }>({ onLayer: () => {} });
