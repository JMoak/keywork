const swHide = 0;

export async function hideConsoleWindow(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "win32") return false;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const kernel = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.ptr } });
    const user = dlopen("user32.dll", {
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    const window = kernel.symbols.GetConsoleWindow();
    if (window === null) return false;
    user.symbols.ShowWindow(window, swHide);
    return true;
  } catch {
    return false;
  }
}
