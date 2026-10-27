#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// No invoke handlers, plugins, shell access, filesystem access, or HTTP bridge.
// Only a packaged, noninteractive limitation page is exposed to the webview.
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::{WebviewUrl, WebviewWindowBuilder};
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("rememberKey — Experimental desktop preview")
                .inner_size(900.0, 700.0)
                .min_inner_size(640.0, 480.0)
                // Permit only Tauri's packaged index, including the initial load.
                // tauri.localhost is Tauri's intercepted asset scheme, NOT a listener.
                .on_navigation(|url| {
                    let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
                    packaged
                        && url.port().is_none()
                        && url.username().is_empty()
                        && url.password().is_none()
                        && matches!(url.path(), "/" | "/index.html")
                        && url.query().is_none()
                        && url.fragment().is_none()
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not start experimental desktop preview");
}
