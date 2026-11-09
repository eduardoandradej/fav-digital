import { inject } from '@angular/core';
import { type CanActivateFn, Router, type Routes } from '@angular/router';
import { SessionService } from './core/session.service';

const authGuard: CanActivateFn = async () => {
  const s = inject(SessionService);
  if (s.sessao() || (await s.load())) return true;
  return inject(Router).parseUrl('/login');
};

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login.page').then((m) => m.LoginPage), title: 'Entrar — FAV Digital' },
  { path: '', canActivate: [authGuard], loadComponent: () => import('./pages/home.page').then((m) => m.HomePage), title: 'Início — FAV Digital' },
  { path: 'favs', canActivate: [authGuard], loadComponent: () => import('./pages/fav-list.page').then((m) => m.FavListPage), title: 'FAV Digital' },
  { path: 'favs/nova', canActivate: [authGuard], loadComponent: () => import('./pages/fav-new.page').then((m) => m.FavNewPage), title: 'Nova FAV' },
  { path: 'favs/:id', canActivate: [authGuard], loadComponent: () => import('./pages/fav-detail.page').then((m) => m.FavDetailPage), title: 'Ficha — FAV Digital' },
  { path: 'encaminhamentos', canActivate: [authGuard], loadComponent: () => import('./pages/queue.page').then((m) => m.QueuePage), title: 'Encaminhamentos' },
  { path: 'etiquetas', canActivate: [authGuard], loadComponent: () => import('./pages/labels.page').then((m) => m.LabelsPage), title: 'Etiquetas de Grande Porte' },
  { path: '**', redirectTo: '' },
];
