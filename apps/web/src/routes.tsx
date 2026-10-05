import { lazy } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './auth/RequireAuth';

const Home = lazy(() => import('./pages/Home'));
const Search = lazy(() => import('./pages/Search'));
const Watch = lazy(() => import('./pages/Watch'));
const Channel = lazy(() => import('./pages/Channel'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const WalletPage = lazy(() => import('./pages/Wallet'));
const History = lazy(() => import('./pages/History'));
const Watchlist = lazy(() => import('./pages/Watchlist'));
const Studio = lazy(() => import('./pages/Studio'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const NotFound = lazy(() => import('./pages/NotFound'));

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/search', element: <Search /> },
      { path: '/watch/:id', element: <Watch /> },
      { path: '/channel/:id', element: <Channel /> },
      { path: '/login', element: <Login /> },
      { path: '/register', element: <Register /> },
      { path: '/wallet', element: <RequireAuth><WalletPage /></RequireAuth> },
      { path: '/history', element: <RequireAuth><History /></RequireAuth> },
      { path: '/watchlist', element: <RequireAuth><Watchlist /></RequireAuth> },
      { path: '/studio', element: <RequireAuth><Studio /></RequireAuth> },
      { path: '/settings', element: <RequireAuth><Settings /></RequireAuth> },
      { path: '/admin', element: <RequireAuth role="ADMIN"><Admin /></RequireAuth> },
      { path: '*', element: <NotFound /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
