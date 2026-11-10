import { createContext, useContext, useState } from 'react'

const STORAGE_KEY = 'selected_entity_id'

const EntityContext = createContext(null)

/**
 * App-wide default entity (== regions.id, '' means "All entities").
 *
 * The dashboard switcher writes this; every other page only reads it, as the
 * seed for its own local dropdown. That keeps a page-level change (e.g. viewing
 * India on Invoices while the app default is USA) from leaking into the rest of
 * the app — the override lives and dies with that page's mount.
 */
export function EntityProvider({ children }) {
  const [entityId, setEntityIdState] = useState(() => localStorage.getItem(STORAGE_KEY) || '')

  const setEntityId = (id) => {
    const next = id == null ? '' : String(id)
    setEntityIdState(next)
    if (next) localStorage.setItem(STORAGE_KEY, next)
    else localStorage.removeItem(STORAGE_KEY)
  }

  return (
    <EntityContext.Provider value={{ entityId, setEntityId }}>
      {children}
    </EntityContext.Provider>
  )
}

export const clearStoredEntity = () => localStorage.removeItem(STORAGE_KEY)

export const useEntity = () => useContext(EntityContext) || { entityId: '', setEntityId: () => {} }

/**
 * The app default, as the initial value for a page's own entity filter.
 * Read once per mount — later dashboard changes never yank a page's dropdown
 * out from under the user.
 */
export function useDefaultEntityId() {
  const { entityId } = useEntity()
  const [seed] = useState(entityId)
  return seed
}
