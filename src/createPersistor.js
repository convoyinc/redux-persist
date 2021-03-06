import { KEY_PREFIX, REHYDRATE } from './constants'
import createAsyncLocalStorage from './defaults/asyncLocalStorage'
import purgeStoredState from './purgeStoredState'
import stringify from 'json-stringify-safe'

export default function createPersistor (store, config) {
  // defaults
  const serializer = config.serialize === false ? (data) => data : defaultSerializer
  const deserializer = config.serialize === false ? (data) => data : defaultDeserializer
  const blacklist = config.blacklist || []
  const whitelist = config.whitelist || false
  const transforms = config.transforms || []
  const debounce = config.debounce || false
  const keyPrefix = config.keyPrefix !== undefined ? config.keyPrefix : KEY_PREFIX

  // pluggable state shape (e.g. immutablejs)
  const stateInit = config._stateInit || {}
  const stateIterator = config._stateIterator || defaultStateIterator
  const stateGetter = config._stateGetter || defaultStateGetter
  const stateSetter = config._stateSetter || defaultStateSetter

  // storage with keys -> getAllKeys for localForage support
  let storage = config.storage || createAsyncLocalStorage('local')
  if (storage.keys && !storage.getAllKeys) {
    storage.getAllKeys = storage.keys
  }

  // initialize stateful values
  let lastState = stateInit
  let paused = false
  let storesToProcess = []
  let timeIterator = null

  store.subscribe(() => {
    if (paused) return

    let state = store.getState()

    findStoresToProcess(state).forEach(key => {
      if (storesToProcess.indexOf(key) !== -1) return
      storesToProcess.push(key)
    })

    lastState = state
    const len = storesToProcess.length

    // time iterator (read: debounce)
    if (timeIterator === null) {
      timeIterator = setInterval(() => {
        if ((paused && len === storesToProcess.length) || storesToProcess.length === 0) {
          clearInterval(timeIterator)
          timeIterator = null
          return
        }

        persistCurrentStateForKey(lastState, storesToProcess[0])
        storesToProcess.shift()
      }, debounce)
    }
  })

  function findStoresToProcess (state) {
    let keys = []
    stateIterator(state, (subState, key) => {
      if (!passWhitelistBlacklist(key)) return
      let newState = stateGetter(state, key)
      if (stateGetter(lastState, key) === newState) return
      keys.push(key)
    })

    return keys
  }

  function persistCurrentStateForKey (state, key) {
    let storageKey = createStorageKey(key)
    let currentState = stateGetter(state, key)
    let endState = transforms.reduce((subState, transformer) => transformer.in(subState, key), currentState)
    if (typeof endState === 'undefined') return null
    return storage.setItem(storageKey, serializer(endState), warnIfSetError(key))
  }

  function persistCurrentState () {
    let state = store.getState()
    let promises = storesToProcess.map(k => persistCurrentStateForKey(state, k))
    storesToProcess.splice(0)
    return promises
  }

  function passWhitelistBlacklist (key) {
    if (whitelist && whitelist.indexOf(key) === -1) return false
    if (blacklist.indexOf(key) !== -1) return false
    return true
  }

  function adhocRehydrate (incoming, options = {}) {
    let state = {}
    if (options.serial) {
      stateIterator(incoming, (subState, key) => {
        try {
          let data = deserializer(subState)
          let value = transforms.reduceRight((interState, transformer) => {
            return transformer.out(interState, key)
          }, data)
          state = stateSetter(state, key, value)
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') console.warn(`Error rehydrating data for key "${key}"`, subState, err)
        }
      })
    } else state = incoming

    store.dispatch(rehydrateAction(state))
    return state
  }

  function createStorageKey (key) {
    return `${keyPrefix}${key}`
  }

  // return `persistor`
  return {
    rehydrate: adhocRehydrate,
    pause: () => { paused = true },
    resume: () => { paused = false },
    purge: (keys) => purgeStoredState({storage, keyPrefix}, keys),
    flush: persistCurrentState
  }
}

function warnIfSetError (key) {
  return function setError (err) {
    if (err && process.env.NODE_ENV !== 'production') { console.warn('Error storing data for key:', key, err) }
  }
}

function defaultSerializer (data) {
  return stringify(data, null, null, (k, v) => {
    if (process.env.NODE_ENV !== 'production') return null
    throw new Error(`
      redux-persist: cannot process cyclical state.
      Consider changing your state structure to have no cycles.
      Alternatively blacklist the corresponding reducer key.
      Cycle encounted at key "${k}" with value "${v}".
    `)
  })
}

function defaultDeserializer (serial) {
  return JSON.parse(serial)
}

function rehydrateAction (data) {
  return {
    type: REHYDRATE,
    payload: data
  }
}

function defaultStateIterator (collection, callback) {
  return Object.keys(collection).forEach((key) => callback(collection[key], key))
}

function defaultStateGetter (state, key) {
  return state[key]
}

function defaultStateSetter (state, key, value) {
  state[key] = value
  return state
}
