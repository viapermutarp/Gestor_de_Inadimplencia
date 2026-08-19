"use client";

import { useEffect, useRef, useState } from "react";
import { IconCalendar, IconChevronLeft, IconChevronRight } from "@/components/icons";

const NOMES_MES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const DIAS_SEMANA = ["D", "S", "T", "Q", "Q", "S", "S"];

function paraIso(ano, mes, dia) {
  const mm = String(mes + 1).padStart(2, "0");
  const dd = String(dia).padStart(2, "0");
  return `${ano}-${mm}-${dd}`;
}

function formatarExibicao(iso) {
  if (!iso) return "";
  const [ano, mes, dia] = iso.split("-");
  if (!ano || !mes || !dia) return "";
  return `${dia}/${mes}/${ano}`;
}

function gerarDiasDoMes(ano, mes) {
  const primeiroDia = new Date(ano, mes, 1);
  const diasNoMes = new Date(ano, mes + 1, 0).getDate();
  const offset = primeiroDia.getDay();
  const celulas = [];

  for (let i = 0; i < offset; i++) celulas.push(null);
  for (let dia = 1; dia <= diasNoMes; dia++) celulas.push(dia);

  return celulas;
}

/**
 * Seletor de data em calendário, com navegação por mês. Controlado por uma
 * string ISO ("YYYY-MM-DD") — mesmo formato esperado pelo backend em
 * "Data Vencimento".
 */
export default function DatePicker({ value, onChange, placeholder = "Selecione a data" }) {
  const [aberto, setAberto] = useState(false);
  const hoje = new Date();
  const dataSelecionada = value ? new Date(`${value}T00:00:00`) : null;

  const [mesVisivel, setMesVisivel] = useState(
    dataSelecionada ? dataSelecionada.getMonth() : hoje.getMonth()
  );
  const [anoVisivel, setAnoVisivel] = useState(
    dataSelecionada ? dataSelecionada.getFullYear() : hoje.getFullYear()
  );

  const containerRef = useRef(null);

  useEffect(() => {
    function handleClickFora(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setAberto(false);
      }
    }
    document.addEventListener("mousedown", handleClickFora);
    return () => document.removeEventListener("mousedown", handleClickFora);
  }, []);

  function abrirNoMesSelecionado() {
    if (dataSelecionada) {
      setMesVisivel(dataSelecionada.getMonth());
      setAnoVisivel(dataSelecionada.getFullYear());
    }
    setAberto((prev) => !prev);
  }

  function irParaMesAnterior() {
    if (mesVisivel === 0) {
      setMesVisivel(11);
      setAnoVisivel((a) => a - 1);
    } else {
      setMesVisivel((m) => m - 1);
    }
  }

  function irParaProximoMes() {
    if (mesVisivel === 11) {
      setMesVisivel(0);
      setAnoVisivel((a) => a + 1);
    } else {
      setMesVisivel((m) => m + 1);
    }
  }

  function selecionarDia(dia) {
    onChange(paraIso(anoVisivel, mesVisivel, dia));
    setAberto(false);
  }

  const celulas = gerarDiasDoMes(anoVisivel, mesVisivel);
  const isHoje = (dia) =>
    dia === hoje.getDate() && mesVisivel === hoje.getMonth() && anoVisivel === hoje.getFullYear();
  const isSelecionado = (dia) =>
    dataSelecionada &&
    dia === dataSelecionada.getDate() &&
    mesVisivel === dataSelecionada.getMonth() &&
    anoVisivel === dataSelecionada.getFullYear();

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={abrirNoMesSelecionado}
        className="flex w-full items-center justify-between rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-left text-sm text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        <span className={`font-mono ${value ? "text-foreground" : "text-muted/60"}`}>
          {value ? formatarExibicao(value) : placeholder}
        </span>
        <IconCalendar className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {aberto && (
        <div className="absolute z-40 mt-2 w-72 rounded-2xl border border-border-soft bg-surface-elevated p-4 shadow-2xl shadow-black/50">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={irParaMesAnterior}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <IconChevronLeft className="h-4 w-4" />
            </button>
            <p className="font-display text-sm font-bold text-foreground">
              {NOMES_MES[mesVisivel]} {anoVisivel}
            </p>
            <button
              type="button"
              onClick={irParaProximoMes}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <IconChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted-foreground">
            {DIAS_SEMANA.map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>

          <div className="mt-1 grid grid-cols-7 gap-1">
            {celulas.map((dia, i) =>
              dia === null ? (
                <span key={`vazio-${i}`} />
              ) : (
                <button
                  key={dia}
                  type="button"
                  onClick={() => selecionarDia(dia)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg font-mono text-xs transition-colors ${
                    isSelecionado(dia)
                      ? "bg-primary font-bold text-primary-foreground"
                      : isHoje(dia)
                        ? "border border-primary/50 text-foreground"
                        : "text-foreground hover:bg-surface-hover"
                  }`}
                >
                  {dia}
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
