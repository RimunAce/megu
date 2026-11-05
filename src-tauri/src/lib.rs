mod auth;
mod animepahe;
mod commands;
mod db;
mod stream_proxy;
mod artwork;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Open SQLite once and expose the connection to commands.
      let conn = db::init_db(app.handle())
        .unwrap_or_else(|e| panic!("failed to init database: {e}"));
      app.manage(std::sync::Mutex::new(conn));
      app.manage(auth::OAuthAttempts::default());
      app.manage(animepahe::VerificationState::default());
      app.manage(stream_proxy::StreamSessions::default());

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::get_db_status,
      commands::cache_media_json,
      commands::get_cached_media,
      artwork::get_cached_artwork,
      artwork::cache_artwork,
      commands::save_airing_feed,
      commands::get_airing_feed,
      commands::get_saved_token,
      commands::logout,
      commands::get_client_id,
      commands::set_client_id,
      commands::sync_user_list,
      commands::get_local_list,
      commands::update_local_entry,
      commands::delete_local_entry,
      commands::open_stream_url,
      commands::open_player_window,
      commands::show_inline_player,
      commands::resize_inline_player,
      commands::close_inline_player,
      commands::player_fullscreen_state,
      commands::restore_player_fullscreen,
      commands::updater_configured,
      stream_proxy::register_stream,
      stream_proxy::fetch_stream,
      stream_proxy::close_stream,
      commands::open_animepahe,
      commands::save_list_snapshot,
      commands::get_list_snapshot,
      commands::queue_progress,
      commands::get_pending_progress,
      commands::clear_pending_progress,
      commands::complete_pending_progress,
      commands::record_recent_episode,
      commands::get_recent_episodes,
      animepahe::animepahe_search,
      animepahe::animepahe_airing,
      animepahe::animepahe_episodes,
      animepahe::animepahe_play,
      auth::cancel_oauth,
      auth::start_oauth
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
