import { AnimatePresence } from "framer-motion";
import { useEffect } from "react";
import LoginModal from "./components/LoginModal";
import Navbar from "./components/Navbar";
import DetailPage from "./pages/Detail";
import Home from "./pages/Home";
import MyListPage from "./pages/MyListPage";
import SearchPage from "./pages/Search";
import SettingsPage from "./pages/Settings";
import SyncManager from "./components/SyncManager";
import SchedulePage from "./pages/Schedule";
import AiringReminders from "./components/AiringReminders";
import UpdateManager from "./components/UpdateManager";
import { restoreSession, useAppStore } from "./store/app";

function App() {
  const { view, detailId } = useAppStore();

  useEffect(() => {
    void restoreSession();
  }, []);


  return (
    <div className="min-h-screen bg-[--color-base] text-zinc-100">
      <Navbar />
      <AnimatePresence mode="wait">
        {view === "home" && <Home key="home" />}
        {view === "search" && <SearchPage key="search" />}
        {view === "mylist" && <MyListPage key="mylist" />}
        {view === "continue" && <MyListPage key="continue" continuing />}
        {view === "settings" && <SettingsPage key="settings" />}
        {view === "schedule" && <SchedulePage key="schedule" />}
        {view === "detail" && detailId && <DetailPage key={`detail-${detailId}`} id={detailId} />}
      </AnimatePresence>
      <LoginModal />
      <SyncManager />
      <AiringReminders />
      <UpdateManager />
    </div>
  );
}

export default App;
