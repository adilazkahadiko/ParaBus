#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn launch() -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let executable = std::env::current_exe()?;
    let root = executable
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing app directory"))?;
    let tray = root.join("scripts").join("router-tray.ps1");
    if !tray.is_file() {
        return Err(std::io::Error::other(
            "ParaBus.exe must stay beside the scripts folder",
        ));
    }
    // No shell interpolation: spaces, quotes and Unicode in the install path
    // are handled by Command's Windows argument quoting.
    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(tray)
        .current_dir(root)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(windows)]
fn main() {
    if let Err(error) = launch() {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn MessageBoxW(
                window: *mut std::ffi::c_void,
                text: *const u16,
                title: *const u16,
                flags: u32,
            ) -> i32;
        }
        let text: Vec<u16> = format!("ParaBus を起動できませんでした。\n{error}\0")
            .encode_utf16()
            .collect();
        let title: Vec<u16> = "ParaBus\0".encode_utf16().collect();
        // The buffers are NUL-terminated and live until the dialog returns.
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
        }
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("ParaBus.exe is a Windows-only launcher. Use ParaBus.app on macOS.");
    std::process::exit(1);
}
