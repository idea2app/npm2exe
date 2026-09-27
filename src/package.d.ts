declare module 'gitignore-to-glob' {
  const gitignoreToGlob: (
    gitignorePath: string,
    dirsToCheck?: string[]
  ) => string[];

  export default gitignoreToGlob;
}
