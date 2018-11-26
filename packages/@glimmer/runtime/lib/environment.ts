import { Reference, PathReference, OpaqueIterable } from '@glimmer/reference';
import { Macros, OpcodeBuilderConstructor } from '@glimmer/opcode-compiler';
import { Simple, RuntimeResolver, CompilableBlock, BlockSymbolTable } from '@glimmer/interfaces';
import { Program } from '@glimmer/program';
import { Dict, Option, Opaque, assert, expect, Drop, DROP } from '@glimmer/util';

import { DOMChanges, DOMTreeConstruction } from './dom/helper';
import { PublicVM } from './vm/append';
import { IArguments } from './vm/arguments';
import { UNDEFINED_REFERENCE, ConditionalReference } from './references';
import { DynamicAttribute, dynamicAttribute } from './vm/attributes/dynamic';
import { Component, ComponentManager, ModifierManager, Modifier } from './internal-interfaces';

export type ScopeBlock = [number | CompilableBlock, ScopeImpl, BlockSymbolTable];
export type BlockValue = ScopeBlock[0 | 1 | 2];
export type ScopeSlot = Option<PathReference<Opaque>> | Option<ScopeBlock>;

export interface DynamicScope {
  get(key: string): PathReference<Opaque>;
  set(key: string, reference: PathReference<Opaque>): PathReference<Opaque>;
  child(): DynamicScope;
}

export interface Scope {
  getSelf(): PathReference<unknown>;
  getSymbol(symbol: number): PathReference<unknown>;
  getBlock(symbol: number): Option<ScopeBlock>;
  getEvalScope(): Option<Dict<ScopeSlot>>;
  getPartialMap(): Option<Dict<PathReference<unknown>>>;
  bind(symbol: number, value: ScopeSlot): void;
  bindSelf(self: PathReference<unknown>): void;
  bindSymbol(symbol: number, value: PathReference<unknown>): void;
  bindBlock(symbol: number, value: Option<ScopeBlock>): void;
  bindEvalScope(map: Option<Dict<ScopeSlot>>): void;
  bindPartialMap(map: Dict<PathReference<Opaque>>): void;
  bindCallerScope(scope: Option<Scope>): void;
  getCallerScope(): Option<Scope>;
  child(): Scope;
}

export interface PartialScope extends Scope {
  bindCallerScope(scope: Option<Scope>): void;
  bindEvalScope(scope: Option<Dict<ScopeSlot>>): void;
}

export class ScopeImpl implements PartialScope {
  static root(self: PathReference<Opaque>, size = 0) {
    let refs: PathReference<Opaque>[] = new Array(size + 1);

    for (let i = 0; i <= size; i++) {
      refs[i] = UNDEFINED_REFERENCE;
    }

    return new ScopeImpl(refs, null, null, null).init({ self });
  }

  static sized(size = 0) {
    let refs: PathReference<Opaque>[] = new Array(size + 1);

    for (let i = 0; i <= size; i++) {
      refs[i] = UNDEFINED_REFERENCE;
    }

    return new ScopeImpl(refs, null, null, null);
  }

  constructor(
    // the 0th slot is `self`
    private slots: ScopeSlot[],
    private callerScope: Option<Scope>,
    // named arguments and blocks passed to a layout that uses eval
    private evalScope: Option<Dict<ScopeSlot>>,
    // locals in scope when the partial was invoked
    private partialMap: Option<Dict<PathReference<Opaque>>>
  ) {}

  init({ self }: { self: PathReference<Opaque> }): this {
    this.slots[0] = self;
    return this;
  }

  getSelf(): PathReference<Opaque> {
    return this.get<PathReference<Opaque>>(0);
  }

  getSymbol(symbol: number): PathReference<Opaque> {
    return this.get<PathReference<Opaque>>(symbol);
  }

  getBlock(symbol: number): Option<ScopeBlock> {
    let block = this.get(symbol);
    return block === UNDEFINED_REFERENCE ? null : (block as ScopeBlock);
  }

  getEvalScope(): Option<Dict<ScopeSlot>> {
    return this.evalScope;
  }

  getPartialMap(): Option<Dict<PathReference<Opaque>>> {
    return this.partialMap;
  }

  bind(symbol: number, value: ScopeSlot) {
    this.set(symbol, value);
  }

  bindSelf(self: PathReference<Opaque>) {
    this.set<PathReference<Opaque>>(0, self);
  }

  bindSymbol(symbol: number, value: PathReference<Opaque>) {
    this.set(symbol, value);
  }

  bindBlock(symbol: number, value: Option<ScopeBlock>) {
    this.set<Option<ScopeBlock>>(symbol, value);
  }

  bindEvalScope(map: Option<Dict<ScopeSlot>>) {
    this.evalScope = map;
  }

  bindPartialMap(map: Dict<PathReference<Opaque>>) {
    this.partialMap = map;
  }

  bindCallerScope(scope: Option<Scope>): void {
    this.callerScope = scope;
  }

  getCallerScope(): Option<Scope> {
    return this.callerScope;
  }

  child(): ScopeImpl {
    return new ScopeImpl(this.slots.slice(), this.callerScope, this.evalScope, this.partialMap);
  }

  private get<T extends ScopeSlot>(index: number): T {
    if (index >= this.slots.length) {
      throw new RangeError(`BUG: cannot get $${index} from scope; length=${this.slots.length}`);
    }

    return this.slots[index] as T;
  }

  private set<T extends ScopeSlot>(index: number, value: T): void {
    if (index >= this.slots.length) {
      throw new RangeError(`BUG: cannot get $${index} from scope; length=${this.slots.length}`);
    }

    this.slots[index] = value;
  }
}

class Transaction {
  public scheduledInstallManagers: ModifierManager[] = [];
  public scheduledInstallModifiers: Modifier[] = [];
  public scheduledUpdateModifierManagers: ModifierManager[] = [];
  public scheduledUpdateModifiers: Modifier[] = [];
  public createdComponents: Component[] = [];
  public createdManagers: ComponentManager[] = [];
  public updatedComponents: Component[] = [];
  public updatedManagers: ComponentManager[] = [];
  public destructors: Drop[] = [];

  didCreate(component: Component, manager: ComponentManager) {
    this.createdComponents.push(component);
    this.createdManagers.push(manager);
  }

  didUpdate(component: Component, manager: ComponentManager) {
    this.updatedComponents.push(component);
    this.updatedManagers.push(manager);
  }

  scheduleInstallModifier(modifier: Modifier, manager: ModifierManager) {
    this.scheduledInstallManagers.push(manager);
    this.scheduledInstallModifiers.push(modifier);
  }

  scheduleUpdateModifier(modifier: Modifier, manager: ModifierManager) {
    this.scheduledUpdateModifierManagers.push(manager);
    this.scheduledUpdateModifiers.push(modifier);
  }

  didDestroy(d: Drop) {
    this.destructors.push(d);
  }

  commit() {
    let { createdComponents, createdManagers } = this;

    for (let i = 0; i < createdComponents.length; i++) {
      let component = createdComponents[i];
      let manager = createdManagers[i];
      manager.didCreate(component);
    }

    let { updatedComponents, updatedManagers } = this;

    for (let i = 0; i < updatedComponents.length; i++) {
      let component = updatedComponents[i];
      let manager = updatedManagers[i];
      manager.didUpdate(component);
    }

    let { destructors } = this;

    for (let i = 0; i < destructors.length; i++) {
      destructors[i][DROP]();
    }

    let { scheduledInstallManagers, scheduledInstallModifiers } = this;

    for (let i = 0; i < scheduledInstallManagers.length; i++) {
      let manager = scheduledInstallManagers[i];
      let modifier = scheduledInstallModifiers[i];
      manager.install(modifier);
    }

    let { scheduledUpdateModifierManagers, scheduledUpdateModifiers } = this;

    for (let i = 0; i < scheduledUpdateModifierManagers.length; i++) {
      let manager = scheduledUpdateModifierManagers[i];
      let modifier = scheduledUpdateModifiers[i];
      manager.update(modifier);
    }
  }
}

export interface CompilationOptions<Locator, R extends RuntimeResolver<Locator>> {
  resolver: R;
  program: Program<Locator>;
  macros: Macros;
  Builder: OpcodeBuilderConstructor;
}

export interface EnvironmentOptions {
  appendOperations: DOMTreeConstruction;
  updateOperations: DOMChanges;
}

const TRANSACTION = Symbol('TRANSACTION');

export abstract class Environment {
  protected updateOperations: DOMChanges;
  protected appendOperations: DOMTreeConstruction;
  private [TRANSACTION]: Option<Transaction> = null;

  constructor({ appendOperations, updateOperations }: EnvironmentOptions) {
    this.appendOperations = appendOperations;
    this.updateOperations = updateOperations;
  }

  toConditionalReference(reference: Reference): Reference<boolean> {
    return new ConditionalReference(reference);
  }

  abstract iterableFor(reference: Reference, key: Opaque): OpaqueIterable;
  abstract protocolForURL(s: string): string;

  getAppendOperations(): DOMTreeConstruction {
    return this.appendOperations;
  }
  getDOM(): DOMChanges {
    return this.updateOperations;
  }

  begin() {
    assert(
      !this[TRANSACTION],
      'A glimmer transaction was begun, but one already exists. You may have a nested transaction, possibly caused by an earlier runtime exception while rendering. Please check your console for the stack trace of any prior exceptions.'
    );

    this[TRANSACTION] = new Transaction();
  }

  private get transaction(): Transaction {
    return expect(this[TRANSACTION]!, 'must be in a transaction');
  }

  didCreate(component: Component, manager: ComponentManager) {
    this.transaction.didCreate(component, manager);
  }

  didUpdate(component: Component, manager: ComponentManager) {
    this.transaction.didUpdate(component, manager);
  }

  scheduleInstallModifier(modifier: Modifier, manager: ModifierManager) {
    this.transaction.scheduleInstallModifier(modifier, manager);
  }

  scheduleUpdateModifier(modifier: Modifier, manager: ModifierManager) {
    this.transaction.scheduleUpdateModifier(modifier, manager);
  }

  didDestroy(d: Drop) {
    this.transaction.didDestroy(d);
  }

  commit() {
    let transaction = this.transaction;
    this[TRANSACTION] = null;
    transaction.commit();
  }

  attributeFor(
    element: Simple.Element,
    attr: string,
    _isTrusting: boolean,
    namespace: Option<string> = null
  ): DynamicAttribute {
    return dynamicAttribute(element, attr, namespace);
  }
}

export function inTransaction(env: Environment, cb: () => void): void {
  if (!env[TRANSACTION]) {
    env.begin();
    try {
      cb();
    } finally {
      env.commit();
    }
  } else {
    cb();
  }
}

export abstract class DefaultEnvironment extends Environment {
  constructor(options?: EnvironmentOptions) {
    if (!options) {
      let document = window.document;
      let appendOperations = new DOMTreeConstruction(document);
      let updateOperations = new DOMChanges(document as HTMLDocument);
      options = { appendOperations, updateOperations };
    }

    super(options);
  }
}

export default Environment;

export interface Helper {
  (vm: PublicVM, args: IArguments): PathReference<Opaque>;
}
