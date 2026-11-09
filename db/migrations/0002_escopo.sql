-- FAV Digital — migração 0002: função de escopo por unidade (usada na leitura e na pesquisa).
SET search_path = fav;

-- Uma FAV "toca" uma unidade quando ela é origem, custodiante, unidade de PJ vinculada, guarda documental,
-- origem/destino de alguma movimentação ou local de algum evento de armazenamento.
CREATE FUNCTION fav.fav_in_unit(p_fav uuid, p_unit uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM fav.fav f WHERE f.id = p_fav
      AND p_unit IN (f.origin_unit_id, f.custodian_unit_id, f.unidade_pj_id, f.guarda_unidade_id))
  OR EXISTS (SELECT 1 FROM fav.movement m WHERE m.fav_id = p_fav AND p_unit IN (m.origin_unit_id, m.dest_unit_id))
  OR EXISTS (SELECT 1 FROM fav.storage_event s WHERE s.fav_id = p_fav AND s.unit_id = p_unit)
$$;

GRANT EXECUTE ON FUNCTION fav.fav_in_unit(uuid, uuid) TO fav_app;
