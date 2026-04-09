import { useState, useEffect, useCallback } from 'react';
import { HealthData } from '../types';
import { API_ENDPOINTS } from '../constants/api';

export function useHealth() {
  const [health, setHealth] = useState<HealthData>({});

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch(API_ENDPOINTS.HEALTH);
      if (!response.ok) {
        console.warn('Health check failed:', response.status);
        setHealth({});
        return;
      }
      const data: HealthData = await response.json();
      setHealth(data);
    } catch (error) {
      console.warn('Health check failed:', error);
      setHealth({});
    }
  }, []);

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, 15_000);
    return () => clearInterval(interval);
  }, [loadHealth]);

  return { health, refreshHealth: loadHealth };
}
