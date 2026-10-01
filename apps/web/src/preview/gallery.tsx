import '@melonoffice/ui/styles.css';
import '../app.css';
import '../office.css';
import '../home.css';
import './gallery.css';
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  FormSection,
  ListItem,
  PageHeader,
  PeriodPicker,
  StateMessage,
  StatusDot,
  Toolbar,
  type AgentState,
  type BadgeTone,
} from '@melonoffice/ui';
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from '../office/icons.js';

/**
 * Every component of packages/ui in every state it has (phases 3 and 5 of the redesign), for
 * review and screenshots. Served by `vite` at `/components.html` only; the build ships none of it.
 * States a pointer causes (hover, pressed, focus) are captured by `scripts/capture-components.mjs`.
 */

const STATES: readonly [AgentState, string][] = [
  ['working', 'Trabajando'],
  ['available', 'Disponible'],
  ['waiting', 'Esperando'],
  ['attention', 'Requiere atención'],
  ['paused', 'En pausa'],
  ['offline', 'Sin conexión'],
];

const TONES: readonly [BadgeTone, string][] = [
  ['neutral', 'Borrador'],
  ['accent', 'Nuevo'],
  ['success', 'Activo'],
  ['warning', 'Propuesto'],
  ['danger', 'Falló'],
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="mo-panel gallery__section" aria-labelledby={id} data-part={id}>
      <header className="mo-panel__header">
        <h2 id={id} className="mo-panel__title">
          {title}
        </h2>
      </header>
      {children}
    </section>
  );
}

function PeriodDemo() {
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('week');
  const names = { today: 'Hoy', week: 'Esta semana', month: 'Este mes' } as const;
  return (
    <PeriodPicker
      label="Periodo"
      options={['today', 'week', 'month'] as const}
      value={period}
      onChange={setPeriod}
      renderOption={(p) => names[p]}
    />
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gallery__row">
      <p className="mo-hint gallery__label">{label}</p>
      <div className="gallery__items">{children}</div>
    </div>
  );
}

function Gallery() {
  const [period, setPeriod] = useState('today');
  const [tab, setTab] = useState('open');
  return (
    <main className="gallery">
      <h1 className="gallery__title">Componentes de MelonOffice</h1>

      <Section id="buttons" title="Botones">
        <Row label="Primario · secundario · discreto · destructivo">
          <Button>Aprobar</Button>
          <Button variant="secondary">Ver trabajo</Button>
          <Button variant="ghost">Más acciones</Button>
          <Button variant="danger">Rechazar</Button>
        </Row>
        <Row label="Con icono · solo icono · pequeño">
          <Button>
            <Icon name="gia" size={18} />
            Dar instrucciones
          </Button>
          <Button variant="secondary" iconOnly aria-label="Cerrar">
            <Icon name="close" size={18} />
          </Button>
          <Button variant="secondary" size="sm">
            Pausar
          </Button>
          <Button variant="ghost" size="sm">
            Ver todo
          </Button>
        </Row>
        <Row label="Cargando · desactivado · activo (pulsado)">
          <Button loading>Enviando</Button>
          <Button variant="secondary" loading>
            Guardando
          </Button>
          <Button disabled>Aprobar</Button>
          <Button variant="secondary" disabled>
            Ver trabajo
          </Button>
          <Button variant="secondary" aria-pressed="true">
            Español
          </Button>
        </Row>
      </Section>

      <Section id="fields" title="Campos y búsqueda">
        <div className="gallery__grid">
          <label className="mo-field">
            <span className="mo-label">Nombre del negocio</span>
            <input defaultValue="Acme" />
          </label>
          <label className="mo-field">
            <span className="mo-label">Tipo de negocio</span>
            <select defaultValue="">
              <option value="">Elige una opción</option>
              <option>Servicios</option>
            </select>
          </label>
          <label className="mo-field">
            <span className="mo-label">Correo</span>
            <input type="email" placeholder="nombre@empresa.com" aria-invalid="true" />
            <span className="mo-error">Escribe un correo con @ y dominio.</span>
          </label>
          <label className="mo-field">
            <span className="mo-label">Ciudad</span>
            <input disabled defaultValue="Lima" />
            <span className="mo-hint">Solo el propietario puede cambiarla.</span>
          </label>
          <label className="mo-field gallery__wide">
            <span className="mo-label">Notas</span>
            <textarea placeholder="Lo que tu oficina debe saber" />
          </label>
          <div className="mo-search gallery__wide">
            <Icon name="search" size={18} className="mo-search__icon" />
            <input type="search" placeholder="Busca departamentos, agentes y pantallas…" />
          </div>
          <label className="gallery__check">
            <input type="checkbox" defaultChecked /> WhatsApp
          </label>
          <label className="gallery__check">
            <input type="radio" name="g" defaultChecked /> Todas
          </label>
        </div>
      </Section>

      <Section id="choices" title="Filtros, segmentos y pestañas">
        <Row label="Filtros (chips)">
          <div className="mo-chips">
            {['Todas', 'Nuevas', 'Abiertas', 'Pendientes'].map((name, i) => (
              <button key={name} type="button" className="mo-chip" aria-pressed={i === 0}>
                {name}
              </button>
            ))}
            <button type="button" className="mo-chip" disabled>
              Cerradas
            </button>
          </div>
        </Row>
        <Row label="Control segmentado">
          <div className="mo-segmented" role="group" aria-label="Periodo">
            {[
              ['today', 'Hoy'],
              ['week', 'Esta semana'],
              ['month', 'Este mes'],
            ].map(([id, name]) => (
              <button
                key={id}
                type="button"
                aria-pressed={period === id}
                onClick={() => setPeriod(id ?? '')}
              >
                {name}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Pestañas">
          <div className="mo-tabs gallery__tabs" role="tablist" aria-label="Conversaciones">
            {[
              ['open', 'Abiertas'],
              ['pending', 'Pendientes'],
              ['closed', 'Cerradas'],
            ].map(([id, name]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id ?? '')}
              >
                {name}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      <Section id="status" title="Badges y estados de agentes">
        <Row label="Badges">
          {TONES.map(([tone, name]) => (
            <Badge key={tone} tone={tone}>
              {name}
            </Badge>
          ))}
          <Badge outline>Pronto</Badge>
          <Badge count>3</Badge>
        </Row>
        <Row label="Estado de un agente: color y forma">
          {STATES.map(([state, name]) => (
            <span key={state} className="gallery__state">
              <StatusDot state={state} />
              {name}
            </span>
          ))}
        </Row>
        <Row label="Avatares">
          <Avatar name="Ana Ventas" size="sm" />
          <Avatar name="Leo Campañas" />
          <Avatar name="Olga Procesos" size="lg" />
        </Row>
        <Row label="Créditos">
          <div className="gallery__credits">
            <p className="gallery__figure">
              <span className="mo-figure">487</span> créditos disponibles
            </p>
            <div
              className="mo-meter"
              role="meter"
              aria-label="Créditos usados"
              aria-valuemin={0}
              aria-valuemax={1000}
              aria-valuenow={513}
            >
              <div className="mo-meter__fill" style={{ width: '51.3%' }} />
            </div>
          </div>
        </Row>
      </Section>

      <Section id="surfaces" title="Superficies">
        <div className="gallery__grid">
          <article className="mo-card">
            <p className="mo-state__title">Tarjeta</p>
            <p className="mo-hint">Reposo: una línea fina y la sombra pequeña.</p>
          </article>
          <button type="button" className="mo-card mo-card--interactive gallery__card">
            <span className="mo-state__title">Tarjeta que se abre</span>
            <span className="mo-hint">Al pasar el puntero se eleva.</span>
          </button>
          <div className="mo-overlay gallery__menu">
            <ul className="mo-menu" aria-label="Tu cuenta">
              <li className="mo-menu__label">Acme</li>
              <li>
                <button type="button" className="mo-menu__item">
                  <Icon name="user" size={18} /> Tu perfil
                </button>
              </li>
              <li>
                <button type="button" className="mo-menu__item">
                  <Icon name="settings" size={18} /> Configuración
                </button>
              </li>
              <li className="mo-menu__separator" aria-hidden="true" />
              <li>
                <button type="button" className="mo-menu__item">
                  <Icon name="signOut" size={18} /> Cerrar sesión
                </button>
              </li>
            </ul>
          </div>
          <div className="gallery__tooltip">
            <Button variant="secondary" iconOnly aria-label="Adjuntar" aria-describedby="tip">
              <Icon name="paperclip" size={18} />
            </Button>
            <span id="tip" role="tooltip" className="mo-tooltip">
              Adjunta un documento para GIA
            </span>
          </div>
        </div>
      </Section>

      <Section id="overlays" title="Diálogo y panel lateral">
        <div className="gallery__stage">
          <div className="mo-overlay gallery__dialog" role="dialog" aria-labelledby="dlg">
            <h3 id="dlg" className="mo-panel__title">
              ¿Pausar a Ana Ventas?
            </h3>
            <p className="mo-hint">Termina la tarea en curso y no recibe trabajo nuevo.</p>
            <div className="gallery__items gallery__end">
              <Button variant="ghost">Cancelar</Button>
              <Button>Pausar</Button>
            </div>
          </div>
          <aside className="mo-overlay gallery__sheet" aria-labelledby="sheet">
            <header className="mo-sheet__header">
              <Avatar name="Ana Ventas" />
              <div className="gallery__who">
                <h3 id="sheet" className="mo-panel__title">
                  Ana Ventas
                </h3>
                <span className="mo-hint">Comercial · Leads</span>
              </div>
              <Button variant="ghost" iconOnly aria-label="Cerrar">
                <Icon name="close" size={18} />
              </Button>
            </header>
            <div className="mo-sheet__body">
              <span className="gallery__state">
                <StatusDot state="working" /> Trabajando
              </span>
              <p className="mo-state__title">Revisar los leads de esta semana</p>
              <div className="gallery__items">
                <Button size="sm">Dar instrucciones</Button>
                <Button variant="secondary" size="sm">
                  Pausar
                </Button>
              </div>
            </div>
          </aside>
        </div>
      </Section>

      <Section id="pages" title="Páginas: cabecera, filtros, tabla, lista y formulario">
        <div className="mo-page">
          <PageHeader
            eyebrow="Configuración"
            title="Documentos"
            description="Los archivos de tu organización que GIA y tus agentes pueden consultar."
            actions={
              <>
                <Button variant="secondary">Exportar</Button>
                <Button>Subir documento</Button>
              </>
            }
          />
          <Toolbar label="Filtros">
            <label className="mo-search">
              <Icon name="search" size={18} className="mo-search__icon" />
              <input type="search" aria-label="Buscar documentos" placeholder="Buscar" />
            </label>
            <div className="mo-chips">
              <button type="button" className="mo-chip" aria-pressed="true">
                Todos
              </button>
              <button type="button" className="mo-chip" aria-pressed="false">
                Pendientes
              </button>
              <button type="button" className="mo-chip" aria-pressed="false">
                Listos
              </button>
            </div>
            <PeriodDemo />
          </Toolbar>
          <ul className="mo-list">
            <ListItem
              title="menu-otoño.docx"
              titleAs="h3"
              meta="4 KB · subido hace 2 horas"
              badges={<Badge tone="success">Listo</Badge>}
              actions={
                <Button variant="ghost" size="sm">
                  Ver
                </Button>
              }
            />
            <ListItem
              title="tarifas-2026.pdf"
              titleAs="h3"
              meta="120 KB · subido ayer"
              badges={<Badge tone="warning">Procesando</Badge>}
            />
          </ul>
          <DataTable label="Créditos por departamento">
            <thead>
              <tr>
                <th scope="col">Departamento</th>
                <th scope="col" className="mo-table__num">
                  Operaciones
                </th>
                <th scope="col" className="mo-table__num">
                  Créditos
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Comercial</td>
                <td className="mo-table__num">42</td>
                <td className="mo-table__num">18</td>
              </tr>
              <tr>
                <td>Marketing</td>
                <td className="mo-table__num">17</td>
                <td className="mo-table__num">9</td>
              </tr>
            </tbody>
          </DataTable>
          <form className="mo-form" onSubmit={(event) => event.preventDefault()}>
            <FormSection title="Tu negocio" description="Lo que GIA sabe de tu empresa.">
              <label className="mo-field">
                <span className="mo-label">Nombre del negocio</span>
                <input defaultValue="Acme" />
              </label>
              <label className="mo-field">
                <span className="mo-label">Sector</span>
                <select defaultValue="food">
                  <option value="food">Restauración</option>
                </select>
              </label>
            </FormSection>
            <div className="mo-form__actions">
              <Button type="submit">Guardar</Button>
              <Button variant="ghost">Cancelar</Button>
            </div>
          </form>
        </div>
      </Section>

      <Section id="states" title="Estados de una lista">
        <div className="gallery__grid">
          <StateMessage kind="loading">Revisando qué te espera…</StateMessage>
          <StateMessage kind="empty" title="Nada pendiente para hoy">
            Cuando un seguimiento venza, aparecerá aquí.
          </StateMessage>
          <StateMessage
            kind="error"
            title="No se pudo cargar la actividad"
            action={
              <Button variant="secondary" size="sm">
                Reintentar
              </Button>
            }
          >
            Revisa tu conexión y vuelve a intentarlo.
          </StateMessage>
          <StateMessage kind="warning" title="Quedan 12 créditos">
            Las tareas se detendrán cuando se acaben.
          </StateMessage>
          <StateMessage kind="success" title="Aprobado">
            Leo Campañas enviará la campaña de octubre.
          </StateMessage>
          <StateMessage kind="empty" inline>
            Aún no hay actividad hoy.
          </StateMessage>
        </div>
      </Section>
    </main>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
createRoot(container).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
