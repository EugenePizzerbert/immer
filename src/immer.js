import * as legacyProxy from "./es5"
import * as modernProxy from "./proxy"
import {applyPatches, generatePatches} from "./patches"
import {
    assign,
    each,
    has,
    is,
    isDraft,
    isDraftable,
    isEnumerable,
    shallowCopy,
    DRAFT_STATE,
    NOTHING
} from "./common"
import {ImmerScope} from "./scope"

function verifyMinified() {}

const configDefaults = {
    useProxies: typeof Proxy !== "undefined" && typeof Reflect !== "undefined",
    autoFreeze:
        typeof process !== "undefined"
            ? process.env.NODE_ENV !== "production"
            : verifyMinified.name === "verifyMinified",
    onAssign: null,
    onDelete: null,
    onCopy: null
}

export class Immer {
    constructor(config) {
        assign(this, configDefaults, config)
        this.setUseProxies(this.useProxies)
        this.produce = this.produce.bind(this)
    }
    produce(base, recipe, patchListener) {
        // curried invocation
        if (typeof base === "function" && typeof recipe !== "function") {
            const defaultBase = recipe
            recipe = base

            // prettier-ignore
            return (base = defaultBase, ...args) =>
                this.produce(base, draft => recipe.call(draft, draft, ...args))
        }

        // prettier-ignore
        {
            if (typeof recipe !== "function") throw new Error("if first argument is not a function, the second argument to produce should be a function")
            if (patchListener !== undefined && typeof patchListener !== "function") throw new Error("the third argument of a producer should not be set or a function")
        }

        let result

        // Only plain objects, arrays, and "immerable classes" are drafted.
        if (isDraftable(base)) {
            const scope = ImmerScope.enter()
            const proxy = this.createProxy(base)
            let hasError = true
            try {
                result = recipe.call(proxy, proxy)
                hasError = false
            } finally {
                // finally instead of catch + rethrow better preserves original stack
                if (hasError) scope.revoke()
                else scope.leave()
            }
            if (result instanceof Promise) {
                return result.then(
                    result => {
                        scope.usePatches(patchListener)
                        return this.processResult(result, scope)
                    },
                    error => {
                        scope.revoke()
                        throw error
                    }
                )
            }
            scope.usePatches(patchListener)
            return this.processResult(result, scope)
        } else {
            result = recipe(base)
            if (result === undefined) return base
            return result !== NOTHING ? result : undefined
        }
    }
    createDraft(base) {
        if (!isDraftable(base)) throw new Error("First argument to createDraft should be a plain object, an array, or an immerable object.") // prettier-ignore
        const scope = ImmerScope.enter()
        const proxy = this.createProxy(base)
        scope.leave()
        proxy[DRAFT_STATE].customDraft = true
        return proxy
    }
    finishDraft(draft, patchListener) {
        if (!isDraft(draft)) throw new Error("First argument to finishDraft should be an object from createDraft.") // prettier-ignore
        const state = draft[DRAFT_STATE]
        if (!state.customDraft) throw new Error("The draft provided was not created using `createDraft`") // prettier-ignore
        if (state.finalized) throw new Error("The draft provided was has already been finished") // prettier-ignore
        // TODO: check if created with createDraft
        // TODO: check if not finsihed twice
        const {scope} = state
        scope.usePatches(patchListener)
        return this.processResult(undefined, scope)
    }
    setAutoFreeze(value) {
        this.autoFreeze = value
    }
    setUseProxies(value) {
        this.useProxies = value
        assign(this, value ? modernProxy : legacyProxy)
    }
    applyPatches(base, patches) {
        // Mutate the base state when a draft is passed.
        if (isDraft(base)) {
            return applyPatches(base, patches)
        }
        // Otherwise, produce a copy of the base state.
        return this.produce(base, draft => applyPatches(draft, patches))
    }
    /** @internal */
    processResult(result, scope) {
        const baseDraft = scope.drafts[0]
        const isReplaced = result !== undefined && result !== baseDraft
        this.willFinalize(scope, result, isReplaced)
        if (isReplaced) {
            if (baseDraft[DRAFT_STATE].modified) {
                scope.revoke()
                throw new Error("An immer producer returned a new value *and* modified its draft. Either return a new value *or* modify the draft.") // prettier-ignore
            }
            if (isDraftable(result)) {
                // Finalize the result in case it contains (or is) a subset of the draft.
                result = this.finalize(result, null, scope)
            }
            if (scope.patches) {
                scope.patches.push({
                    op: "replace",
                    path: [],
                    value: result
                })
                scope.inversePatches.push({
                    op: "replace",
                    path: [],
                    value: baseDraft[DRAFT_STATE].base
                })
            }
        } else {
            // Finalize the base draft.
            result = this.finalize(baseDraft, [], scope)
        }
        scope.revoke()
        if (scope.patches) {
            scope.patchListener(scope.patches, scope.inversePatches)
        }
        return result !== NOTHING ? result : undefined
    }
    /**
     * @internal
     * Finalize a draft, returning either the unmodified base state or a modified
     * copy of the base state.
     */
    finalize(draft, path, scope) {
        const state = draft[DRAFT_STATE]
        if (!state) {
            if (Object.isFrozen(draft)) return draft
            return this.finalizeTree(draft, null, scope)
        }
        // Never finalize drafts owned by another scope.
        if (state.scope !== scope) {
            return draft
        }
        if (!state.modified) {
            return state.base
        }
        if (!state.finalized) {
            state.finalized = true
            this.finalizeTree(state.draft, path, scope)

            if (this.onDelete) {
                // The `assigned` object is unreliable with ES5 drafts.
                if (this.useProxies) {
                    const {assigned} = state
                    for (const prop in assigned) {
                        if (!assigned[prop]) this.onDelete(state, prop)
                    }
                } else {
                    const {base, copy} = state
                    each(base, prop => {
                        if (!has(copy, prop)) this.onDelete(state, prop)
                    })
                }
            }
            if (this.onCopy) {
                this.onCopy(state)
            }

            // At this point, all descendants of `state.copy` have been finalized,
            // so we can be sure that `scope.canAutoFreeze` is accurate.
            if (this.autoFreeze && scope.canAutoFreeze) {
                Object.freeze(state.copy)
            }

            if (path && scope.patches) {
                generatePatches(
                    state,
                    path,
                    scope.patches,
                    scope.inversePatches
                )
            }
        }
        return state.copy
    }
    /**
     * @internal
     * Finalize all drafts in the given state tree.
     */
    finalizeTree(root, rootPath, scope) {
        const state = root[DRAFT_STATE]
        if (state) {
            if (!this.useProxies) {
                state.finalizing = true
                state.copy = shallowCopy(state.draft, true)
                state.finalizing = false
            }
            root = state.copy
        }

        const needPatches = !!rootPath && !!scope.patches
        const finalizeProperty = (prop, value, parent) => {
            if (value === parent) {
                throw Error("Immer forbids circular references")
            }

            // In the `finalizeTree` method, only the `root` object may be a draft.
            const isDraftProp = !!state && parent === root

            if (isDraft(value)) {
                const path =
                    isDraftProp && needPatches && !state.assigned[prop]
                        ? rootPath.concat(prop)
                        : null

                // Drafts owned by `scope` are finalized here.
                value = this.finalize(value, path, scope)

                // Drafts from another scope must prevent auto-freezing.
                if (isDraft(value)) {
                    scope.canAutoFreeze = false
                }

                // Preserve non-enumerable properties.
                if (Array.isArray(parent) || isEnumerable(parent, prop)) {
                    parent[prop] = value
                } else {
                    Object.defineProperty(parent, prop, {value})
                }

                // Unchanged drafts are never passed to the `onAssign` hook.
                if (isDraftProp && value === state.base[prop]) return
            }
            // Unchanged draft properties are ignored.
            else if (isDraftProp && is(value, state.base[prop])) {
                return
            }
            // Search new objects for unfinalized drafts. Frozen objects should never contain drafts.
            else if (isDraftable(value) && !Object.isFrozen(value)) {
                each(value, finalizeProperty)
            }

            if (isDraftProp && this.onAssign) {
                this.onAssign(state, prop, value)
            }
        }

        each(root, finalizeProperty)
        return root
    }
}
