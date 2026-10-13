export function projectPath(...parts: string[]): string;
export function artifactsPath(...parts: string[]): string;
export function linkDependencies(directory: string): Promise<void>;
export function temporaryDirectory(prefix: string, modules?: boolean): Promise<string>;
