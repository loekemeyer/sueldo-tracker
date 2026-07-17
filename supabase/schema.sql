-- Schema para sueldo-tracker
-- Ejecutar en: https://supabase.com/dashboard/project/ljwlanwmnuqgxftlirhh/sql/new

CREATE TABLE IF NOT EXISTS public.movimientos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tipo TEXT NOT NULL CHECK (tipo IN ('horas', 'ingreso', 'egreso')),
  horas NUMERIC,
  monto NUMERIC NOT NULL,
  descripcion TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_movimientos_fecha ON public.movimientos (fecha DESC);

ALTER TABLE public.movimientos ENABLE ROW LEVEL SECURITY;

-- Single-user, sin auth: el anon key puede hacer todo.
-- Si más adelante se agrega Supabase Auth, cambiar a USING (auth.uid() = user_id).
CREATE POLICY "sueldo_allow_all" ON public.movimientos
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ==== Inversiones ====
-- tipo_activo:
--   'cedear'    -> CEDEAR: precio_ars por CEDEAR (ARS), se dolariza con mep. El ratio
--                  (CEDEARs por acción real) lo maneja la app (localStorage, sembrado
--                  con valores conocidos y consultado al usuario para tickers nuevos).
--   'accion_us' -> Acción de EEUU comprada en dólares: precio_usd por acción, sin ratio.
--   'usd'       -> Dólar cash: cantidad = USD, precio_ars = tipo de cambio, mep = mismo.
-- IMPORTANTE: tipo_activo es TEXT libre (sin CHECK). Si tu tabla tiene un CHECK que sólo
-- permite ('cedear','usd'), ejecutá el ALTER de más abajo para aceptar 'accion_us'.
CREATE TABLE IF NOT EXISTS public.inversiones (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker TEXT NOT NULL,
  tipo_activo TEXT NOT NULL DEFAULT 'cedear',
  cantidad NUMERIC NOT NULL,
  precio_ars NUMERIC,
  precio_usd NUMERIC,
  mep NUMERIC,
  notas TEXT
);

CREATE INDEX IF NOT EXISTS idx_inversiones_fecha ON public.inversiones (fecha DESC);

ALTER TABLE public.inversiones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inversiones_allow_all" ON public.inversiones
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Migración: si ya tenías la tabla con un CHECK viejo sobre tipo_activo, corré esto una vez
-- para permitir el nuevo valor 'accion_us' (reemplazá <nombre_check> por el nombre real,
-- visible en el Table Editor de Supabase). Si tipo_activo no tiene CHECK, ignorá este bloque.
-- ALTER TABLE public.inversiones DROP CONSTRAINT IF EXISTS <nombre_check>;
-- ALTER TABLE public.inversiones ADD CONSTRAINT inversiones_tipo_activo_check
--   CHECK (tipo_activo IN ('cedear', 'accion_us', 'usd'));

-- Precios actuales (los actualiza un job externo). precio_usd = precio del subyacente.
CREATE TABLE IF NOT EXISTS public.precios_actuales (
  ticker TEXT PRIMARY KEY,
  precio_ars NUMERIC,
  precio_usd NUMERIC,
  actualizado TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.precios_actuales ENABLE ROW LEVEL SECURITY;

CREATE POLICY "precios_allow_all" ON public.precios_actuales
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
