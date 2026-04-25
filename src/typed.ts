export interface Typed<TypeName extends string> {
  readonly _tag: TypeName;
}
