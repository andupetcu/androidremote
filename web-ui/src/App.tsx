import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { DevicesPage } from './pages/DevicesPage';
import { DeviceDetail } from './pages/DeviceDetail';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { PoliciesPage } from './pages/PoliciesPage';
import { PolicyDetailPage } from './pages/PolicyDetailPage';
import { EventsPage } from './pages/EventsPage';
import { AppsPage } from './pages/AppsPage';
import { AuditPage } from './pages/AuditPage';
import { SettingsPage } from './pages/SettingsPage';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="devices/:deviceId" element={<DeviceDetail />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="groups/:groupId" element={<GroupDetailPage />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="policies/:policyId" element={<PolicyDetailPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="apps" element={<AppsPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
